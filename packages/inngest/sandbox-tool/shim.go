// Shim mode: stands in for a program on PATH, asks the host what to do through the inngestShim tool and acts on the answer.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
)

const shimToolName = "inngestShim"

type localReply struct {
	Exit   int    `json:"exit"`
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}

type shimSpec struct {
	Stdin bool                  `json:"stdin"`
	Local map[string]localReply `json:"local"`
	Only  []string              `json:"only"`
}

type shimCall struct {
	Name  string   `json:"name"`
	Argv  []string `json:"argv"`
	Cwd   string   `json:"cwd"`
	Stdin string   `json:"stdin"`
}

type execAction struct {
	Argv  *[]string         `json:"argv"`
	Env   map[string]string `json:"env"`
	Stdin *string           `json:"stdin"`
}

type shimAction struct {
	Exec      *execAction `json:"exec"`
	Exit      *int        `json:"exit"`
	Stdout    string      `json:"stdout"`
	Stderr    string      `json:"stderr"`
	StdoutB64 string      `json:"stdoutB64"`
	StderrB64 string      `json:"stderrB64"`
}

// loadSpec reads the shim's entry of the config. Without INNGEST_SHIMS_DIR
// there is no config and the defaults apply; with it, a config that cannot be
// read is an error, since dropping it would silently change what the shim does.
func loadSpec(name string) (shimSpec, error) {
	dir := os.Getenv("INNGEST_SHIMS_DIR")
	if dir == "" {
		return shimSpec{}, nil
	}
	data, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return shimSpec{}, err
	}
	var all map[string]shimSpec
	if err := json.Unmarshal(data, &all); err != nil {
		return shimSpec{}, err
	}
	return all[name], nil
}

// findReal looks name up on PATH with the shims directory removed.
func findReal(name string) string {
	own := ""
	if dir := os.Getenv("INNGEST_SHIMS_DIR"); dir != "" {
		own = filepath.Clean(filepath.Join(dir, "bin"))
	}
	self, _ := os.Executable()
	self, _ = filepath.EvalSymlinks(self)
	for _, entry := range filepath.SplitList(os.Getenv("PATH")) {
		if entry == "" {
			entry = "."
		}
		if own != "" && filepath.Clean(entry) == own {
			continue
		}
		file := filepath.Join(entry, name)
		info, err := os.Stat(file)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		// A copy of this program on PATH (a shim whose directory is not
		// `own`) would run itself forever.
		if resolved, err := filepath.EvalSymlinks(file); err == nil && resolved == self {
			continue
		}
		return file
	}
	return ""
}

func mergedEnv(extra map[string]string) []string {
	env := os.Environ()
	if len(extra) == 0 {
		return env
	}
	out := make([]string, 0, len(env)+len(extra))
	for _, kv := range env {
		key, _, _ := strings.Cut(kv, "=")
		if _, replaced := extra[key]; !replaced {
			out = append(out, kv)
		}
	}
	for k, v := range extra {
		out = append(out, k+"="+v)
	}
	return out
}

func runReal(name string, argv []string, env map[string]string, stdin *string) int {
	file := findReal(name)
	if file == "" {
		fmt.Fprintf(os.Stderr, "%s: command not found\n", name)
		return 127
	}
	if stdin == nil {
		err := syscall.Exec(file, append([]string{name}, argv...), mergedEnv(env))
		fmt.Fprintf(os.Stderr, "%s: %v\n", name, err)
		return 126
	}

	cmd := exec.Command(file, argv...)
	cmd.Args[0] = name
	cmd.Env = mergedEnv(env)
	cmd.Stdin = strings.NewReader(*stdin)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", name, err)
		return 126
	}
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		for s := range sigs {
			cmd.Process.Signal(s)
		}
	}()
	err := cmd.Wait()
	signal.Stop(sigs)
	close(sigs)

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return 128 + int(ws.Signal())
		}
		return exitErr.ExitCode()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", name, err)
		return 126
	}
	return 0
}

func writeOutputs(stdout, stderr string, stdoutB64, stderrB64 string) {
	emit := func(w io.Writer, text, b64 string) {
		if b64 != "" {
			if data, err := base64.StdEncoding.DecodeString(b64); err == nil {
				w.Write(data)
				return
			}
		}
		io.WriteString(w, text)
	}
	emit(os.Stdout, stdout, stdoutB64)
	emit(os.Stderr, stderr, stderrB64)
}

// wantsHandler reports whether the call goes to the host: always without an
// "only" list, otherwise when one of the arguments is on it.
func wantsHandler(only []string, args []string) bool {
	if len(only) == 0 {
		return true
	}
	for _, arg := range args {
		for _, word := range only {
			if arg == word {
				return true
			}
		}
	}
	return false
}

func runShim(name string, args []string) int {
	spec, err := loadSpec(name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: cannot read the shim config: %v\n", name, err)
		return 125
	}
	if len(args) > 0 {
		if local, ok := spec.Local[args[0]]; ok {
			writeOutputs(local.Stdout, local.Stderr, "", "")
			return local.Exit
		}
	}
	dir := os.Getenv("INNGEST_TOOLS_DIR")
	if dir == "" || !wantsHandler(spec.Only, args) {
		return runReal(name, args, nil, nil)
	}

	stdin := ""
	if spec.Stdin {
		data, _ := io.ReadAll(os.Stdin)
		stdin = string(data)
	}
	readStdin := spec.Stdin
	cwd, _ := os.Getwd()
	arg, err := encodeNoEscape(shimCall{Name: name, Argv: append([]string{}, args...), Cwd: cwd, Stdin: stdin})
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", name, err)
		return 125
	}
	result, err := callTool(dir, shimToolName, []json.RawMessage{arg})
	if err != nil {
		var te *toolError
		if errors.As(err, &te) {
			fmt.Fprintf(os.Stderr, "%s: %s\n", name, te.message)
		} else {
			fmt.Fprintf(os.Stderr, "%s: %v\n", name, err)
		}
		return 125
	}

	var action shimAction
	dec := json.NewDecoder(bytes.NewReader(result))
	if dec.Decode(&action) != nil || (action.Exec == nil) == (action.Exit == nil) {
		fmt.Fprintf(os.Stderr, "%s: bad reply from the host\n", name)
		return 125
	}
	if action.Exec != nil {
		argv := args
		if action.Exec.Argv != nil {
			argv = *action.Exec.Argv
		}
		input := action.Exec.Stdin
		if input == nil && readStdin {
			// The program gets the stdin this process already drained.
			input = &stdin
		}
		return runReal(name, argv, action.Exec.Env, input)
	}
	if *action.Exit < 0 || *action.Exit > 255 {
		fmt.Fprintf(os.Stderr, "%s: bad reply from the host\n", name)
		return 125
	}
	writeOutputs(action.Stdout, action.Stderr, action.StdoutB64, action.StderrB64)
	return *action.Exit
}
