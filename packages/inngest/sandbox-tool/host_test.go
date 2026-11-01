// Test helpers: builds the binary once and plays the host side of the tools channel.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var binPath string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "inngest-tool-test-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	binPath = filepath.Join(dir, "inngest-tool")
	out, err := exec.Command("go", "build", "-o", binPath, ".").CombinedOutput()
	if err != nil {
		fmt.Fprintf(os.Stderr, "build failed: %v\n%s", err, out)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

type handler func(args []json.RawMessage) (any, error)

type host struct {
	dir      string
	mu       sync.Mutex
	calls    []callLine
	handlers map[string]handler
	stop     chan struct{}
	done     chan struct{}
}

// newHost creates a tools directory and answers calls from handlers until the test ends.
func newHost(t *testing.T, handlers map[string]handler) *host {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ops.log"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	h := &host{dir: dir, handlers: handlers, stop: make(chan struct{}), done: make(chan struct{})}
	go h.loop()
	t.Cleanup(func() {
		close(h.stop)
		<-h.done
	})
	return h
}

func (h *host) loop() {
	defer close(h.done)
	path := filepath.Join(h.dir, "ops.log")
	seen := 0
	for {
		select {
		case <-h.stop:
			return
		case <-time.After(time.Millisecond):
		}
		data, err := os.ReadFile(path)
		if err != nil || len(data) <= seen {
			continue
		}
		end := bytes.LastIndexByte(data, '\n') + 1
		if end <= seen {
			continue
		}
		for _, line := range strings.Split(strings.TrimSuffix(string(data[seen:end]), "\n"), "\n") {
			var call callLine
			if json.Unmarshal([]byte(line), &call) != nil || call.Op != "call" {
				continue
			}
			h.mu.Lock()
			h.calls = append(h.calls, call)
			h.mu.Unlock()
			h.answer(call)
		}
		seen = end
	}
}

func (h *host) answer(call callLine) {
	var outcome map[string]any
	fn, ok := h.handlers[call.Tool]
	if !ok {
		outcome = map[string]any{"error": "Unknown tool: " + call.Tool}
	} else if result, err := fn(call.Args); err != nil {
		outcome = map[string]any{"error": err.Error()}
	} else {
		outcome = map[string]any{"result": result}
	}
	h.append(map[string]any{"op": "reply", "id": call.ID}, outcome)
}

// append writes one line with op and id first, as the tool runner does.
func (h *host) append(head map[string]any, tail map[string]any) {
	line := fmt.Sprintf(`{"op":%q,"id":%d,`, head["op"], head["id"])
	for _, key := range []string{"result", "error"} {
		if v, ok := tail[key]; ok {
			b, _ := encodeNoEscape(v)
			line += fmt.Sprintf("%q:%s}", key, b)
		}
	}
	h.appendRaw(line)
}

func (h *host) appendRaw(line string) {
	f, err := os.OpenFile(filepath.Join(h.dir, "ops.log"), os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return
	}
	defer f.Close()
	f.WriteString(line + "\n")
}

func (h *host) callsTo(tool string) []callLine {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []callLine
	for _, c := range h.calls {
		if c.Tool == tool {
			out = append(out, c)
		}
	}
	return out
}

type result struct {
	code           int
	stdout, stderr string
}

// execute runs the built binary (argv0 overrides the invoked name through a symlink).
func execute(t *testing.T, env []string, stdin string, argv0 string, args ...string) result {
	t.Helper()
	path := binPath
	if argv0 != "" && argv0 != "inngest-tool" {
		link := filepath.Join(t.TempDir(), argv0)
		if err := os.Symlink(binPath, link); err != nil {
			t.Fatal(err)
		}
		path = link
	}
	cmd := exec.Command(path, args...)
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdin = strings.NewReader(stdin)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return result{code, out.String(), errb.String()}
}
