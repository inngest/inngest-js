// The tools channel client: claims a request id, appends one call line to ops.log and polls for the reply.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

const (
	maxRequestBytes = 256 * 1024
	pollInterval    = 10 * time.Millisecond
	usage           = "usage: inngest-tool [-j] [-r] [--stdin] <tool> [arg...] (inside a command with tools)\n"
)

type toolError struct{ message string }

func (e *toolError) Error() string { return e.message }

var errExited = fmt.Errorf("the command has already exited")

type callLine struct {
	Op     string            `json:"op"`
	ID     int               `json:"id"`
	Tool   string            `json:"tool"`
	Args   []json.RawMessage `json:"args"`
	Kwargs map[string]any    `json:"kwargs"`
}

func encodeNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// claimID creates id.N for the first N from 1 that does not exist yet.
func claimID(dir string) (int, error) {
	for id := 1; ; id++ {
		err := os.Mkdir(filepath.Join(dir, "id."+strconv.Itoa(id)), 0o777)
		if err == nil {
			return id, nil
		}
		if !os.IsExist(err) {
			return 0, err
		}
	}
}

// callTool sends one request and returns the raw JSON result of the reply.
// A tool error is a *toolError; an exit line in the log gives errExited.
func callTool(dir, name string, args []json.RawMessage) (json.RawMessage, error) {
	id, err := claimID(dir)
	if err != nil {
		return nil, err
	}
	line, err := encodeNoEscape(callLine{Op: "call", ID: id, Tool: name, Args: args, Kwargs: map[string]any{}})
	if err != nil {
		return nil, err
	}
	if len(line) > maxRequestBytes {
		return nil, fmt.Errorf("request to %s is too large", name)
	}

	log, err := os.OpenFile(filepath.Join(dir, "ops.log"), os.O_RDWR|os.O_APPEND|os.O_CREATE, 0o666)
	if err != nil {
		return nil, err
	}
	defer log.Close()
	info, err := log.Stat()
	if err != nil {
		return nil, err
	}
	start := info.Size()
	if _, err := log.Write(append(line, '\n')); err != nil {
		return nil, err
	}
	return awaitReply(log, start, id)
}

// awaitReply reads the log from offset start, complete lines only, until the reply for id or an exit line.
func awaitReply(log *os.File, start int64, id int) (json.RawMessage, error) {
	prefix := []byte(`{"op":"reply","id":` + strconv.Itoa(id) + `,`)
	exitPrefix := []byte(`{"op":"exit"`)
	off := start
	var pending []byte
	checkedBefore := false
	chunk := make([]byte, 64*1024)

	for {
		for {
			n, err := log.ReadAt(chunk, off)
			pending = append(pending, chunk[:n]...)
			off += int64(n)
			if n == 0 || (err != nil && err != io.EOF) {
				break
			}
		}
		for {
			i := bytes.IndexByte(pending, '\n')
			if i < 0 {
				break
			}
			found := pending[:i]
			pending = pending[i+1:]
			if bytes.HasPrefix(found, prefix) {
				return parseReply(found)
			}
			if bytes.HasPrefix(found, exitPrefix) {
				return nil, errExited
			}
		}
		if !checkedBefore {
			checkedBefore = true
			if exitedBefore(log, start) {
				return nil, errExited
			}
		}
		time.Sleep(pollInterval)
	}
}

// exitedBefore reports whether an exit line sits in the first n bytes of the log.
func exitedBefore(log *os.File, n int64) bool {
	data := make([]byte, n)
	got, _ := log.ReadAt(data, 0)
	data = data[:got]
	if bytes.HasPrefix(data, []byte(`{"op":"exit"`)) {
		return true
	}
	return bytes.Contains(data, []byte("\n{\"op\":\"exit\""))
}

func parseReply(line []byte) (json.RawMessage, error) {
	var reply map[string]json.RawMessage
	if err := json.Unmarshal(line, &reply); err != nil {
		return nil, fmt.Errorf("bad reply from the host: %v", err)
	}
	if raw, ok := reply["error"]; ok {
		var message string
		if json.Unmarshal(raw, &message) != nil {
			message = string(raw)
		}
		return nil, &toolError{message}
	}
	if raw, ok := reply["result"]; ok {
		return raw, nil
	}
	return json.RawMessage("null"), nil
}

func runClient(argv []string, stdin io.Reader, stdout, stderr io.Writer) int {
	var raw, asJSON, readStdin bool
	i := 0
flags:
	for ; i < len(argv); i++ {
		switch argv[i] {
		case "-r":
			raw = true
		case "-j":
			asJSON = true
		case "--stdin":
			readStdin = true
		default:
			break flags
		}
	}
	dir := os.Getenv("INNGEST_TOOLS_DIR")
	if i >= len(argv) || argv[i] == "" || dir == "" {
		io.WriteString(stderr, usage)
		return 2
	}
	name := argv[i]

	var args []json.RawMessage
	for _, a := range argv[i+1:] {
		if asJSON {
			if !json.Valid([]byte(a)) {
				fmt.Fprintf(stderr, "inngest-tool: not valid JSON: %s\n", a)
				return 2
			}
			args = append(args, json.RawMessage(a))
			continue
		}
		b, _ := encodeNoEscape(a)
		args = append(args, b)
	}
	if readStdin {
		data, err := io.ReadAll(stdin)
		if err != nil {
			fmt.Fprintf(stderr, "inngest-tool: %v\n", err)
			return 2
		}
		b, _ := encodeNoEscape(string(data))
		args = append(args, b)
	}
	if args == nil {
		args = []json.RawMessage{}
	}

	result, err := callTool(dir, name, args)
	switch e := err.(type) {
	case nil:
	case *toolError:
		fmt.Fprintln(stderr, e.message)
		return 1
	default:
		if err == errExited {
			fmt.Fprintln(stderr, "inngest-tool: the command has already exited")
			return 3
		}
		fmt.Fprintf(stderr, "inngest-tool: %v\n", err)
		return 2
	}

	if raw {
		var s string
		if json.Unmarshal(result, &s) == nil && len(result) > 0 && result[0] == '"' {
			io.WriteString(stdout, s)
			return 0
		}
	}
	stdout.Write(append([]byte(result), '\n'))
	return 0
}
