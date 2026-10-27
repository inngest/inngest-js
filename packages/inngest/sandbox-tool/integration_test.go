// Integration tests: the built binary against a temp tools directory answered by an in-process host loop.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func echoHandlers() map[string]handler {
	return map[string]handler{
		"echo": func(args []json.RawMessage) (any, error) {
			out := make([]any, len(args))
			for i, a := range args {
				out[i] = json.RawMessage(a)
			}
			return out, nil
		},
		"text": func(args []json.RawMessage) (any, error) {
			var s string
			json.Unmarshal(args[0], &s)
			return s, nil
		},
		"fail": func(args []json.RawMessage) (any, error) {
			return nil, fmt.Errorf("boom \"quoted\"")
		},
		"size": func(args []json.RawMessage) (any, error) {
			var s string
			json.Unmarshal(args[0], &s)
			return len(s), nil
		},
	}
}

func toolEnv(h *host) []string { return []string{"INNGEST_TOOLS_DIR=" + h.dir} }

func TestStringArgs(t *testing.T) {
	h := newHost(t, echoHandlers())
	r := execute(t, toolEnv(h), "", "", "echo", "a", "b \"c\"\n<&>", "")
	if r.code != 0 || r.stdout != `["a","b \"c\"\n<&>",""]`+"\n" {
		t.Fatalf("%+v", r)
	}
}

func TestJSONArgs(t *testing.T) {
	h := newHost(t, echoHandlers())
	r := execute(t, toolEnv(h), "", "", "-j", "echo", `{"a":[1,2]}`, `"s"`, "null", "3")
	if r.code != 0 || r.stdout != `[{"a":[1,2]},"s",null,3]`+"\n" {
		t.Fatalf("%+v", r)
	}
	if r := execute(t, toolEnv(h), "", "", "-j", "echo", "{nope"); r.code != 2 {
		t.Fatalf("invalid json should be misuse: %+v", r)
	}
}

func TestRawOutput(t *testing.T) {
	h := newHost(t, echoHandlers())
	r := execute(t, toolEnv(h), "", "", "-r", "text", "line1\n\"q\" \\ \t é\n")
	if r.code != 0 || r.stdout != "line1\n\"q\" \\ \t é\n" {
		t.Fatalf("%+v", r)
	}
	r = execute(t, toolEnv(h), "", "", "-r", "echo", "x")
	if r.stdout != `["x"]`+"\n" {
		t.Fatalf("non-string stays JSON: %+v", r)
	}
}

func TestStdinKeepsTrailingNewlines(t *testing.T) {
	h := newHost(t, echoHandlers())
	r := execute(t, toolEnv(h), "hello\n\n", "", "-r", "--stdin", "echo", "first")
	if r.code != 0 || r.stdout != `["first","hello\n\n"]`+"\n" {
		t.Fatalf("%+v", r)
	}
}

func TestToolError(t *testing.T) {
	h := newHost(t, echoHandlers())
	r := execute(t, toolEnv(h), "", "", "fail")
	if r.code != 1 || r.stderr != "boom \"quoted\"\n" || r.stdout != "" {
		t.Fatalf("%+v", r)
	}
}

func TestMisuse(t *testing.T) {
	r := execute(t, []string{"INNGEST_TOOLS_DIR="}, "", "", "echo")
	if r.code != 2 || !strings.HasPrefix(r.stderr, "usage: inngest-tool") {
		t.Fatalf("%+v", r)
	}
	h := newHost(t, echoHandlers())
	if r := execute(t, toolEnv(h), "", ""); r.code != 2 {
		t.Fatalf("no tool: %+v", r)
	}
}

func TestExitOp(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "ops.log"), []byte(`{"op":"exit","code":0,"stdout":"","stderr":""}`+"\n"), 0o644)
	r := execute(t, []string{"INNGEST_TOOLS_DIR=" + dir}, "", "", "echo")
	if r.code != 3 || !strings.Contains(r.stderr, "already exited") {
		t.Fatalf("exit before the call: %+v", r)
	}

	// An exit that arrives while waiting.
	dir = t.TempDir()
	os.WriteFile(filepath.Join(dir, "ops.log"), nil, 0o644)
	h := &host{dir: dir}
	done := make(chan result)
	go func() { done <- execute(t, []string{"INNGEST_TOOLS_DIR=" + dir}, "", "", "echo") }()
	for {
		data, _ := os.ReadFile(filepath.Join(dir, "ops.log"))
		if strings.Contains(string(data), `"op":"call"`) {
			break
		}
	}
	h.appendRaw(`{"op":"exit","code":0,"stdout":"","stderr":""}`)
	if r := <-done; r.code != 3 {
		t.Fatalf("%+v", r)
	}
}

func TestParallelClientsClaimDifferentIDs(t *testing.T) {
	h := newHost(t, echoHandlers())
	var wg sync.WaitGroup
	results := make([]result, 12)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = execute(t, toolEnv(h), "", "", "echo", fmt.Sprint(i))
		}(i)
	}
	wg.Wait()
	for i, r := range results {
		if r.code != 0 || r.stdout != fmt.Sprintf("[\"%d\"]\n", i) {
			t.Fatalf("client %d got %+v", i, r)
		}
	}
	seen := map[int]bool{}
	for _, c := range h.callsTo("echo") {
		if seen[c.ID] {
			t.Fatalf("id %d used twice", c.ID)
		}
		seen[c.ID] = true
	}
	if len(seen) != len(results) {
		t.Fatalf("ids: %v", seen)
	}
}

func TestRequestSizeLimit(t *testing.T) {
	h := newHost(t, echoHandlers())
	overhead := len(`{"op":"call","id":1,"tool":"size","args":[""],"kwargs":{}}`)
	under := strings.Repeat("a", maxRequestBytes-overhead)
	r := execute(t, toolEnv(h), under, "", "-r", "--stdin", "size")
	if r.code != 0 || r.stdout != fmt.Sprint(len(under))+"\n" {
		t.Fatalf("exactly at the limit: %d %q %q", r.code, r.stdout, r.stderr)
	}
	r = execute(t, toolEnv(h), under+"a", "", "-r", "--stdin", "size")
	if r.code != 2 || !strings.Contains(r.stderr, "too large") {
		t.Fatalf("over the limit: code %d %q", r.code, r.stderr)
	}
}

func shimFixture(t *testing.T, config string) (shims, real string, env []string) {
	t.Helper()
	shims = t.TempDir()
	os.Mkdir(filepath.Join(shims, "bin"), 0o755)
	os.WriteFile(filepath.Join(shims, "config.json"), []byte(config), 0o644)
	real = t.TempDir()
	script := "#!/bin/sh\necho \"argv=$*\"\necho \"tok=$TOKEN\"\nif [ -n \"$READ\" ]; then cat; fi\nexit ${CODE:-0}\n"
	os.WriteFile(filepath.Join(real, "fake"), []byte(script), 0o755)
	env = []string{
		"INNGEST_SHIMS_DIR=" + shims,
		"PATH=" + filepath.Join(shims, "bin") + ":" + real + ":/usr/bin:/bin",
	}
	return
}

func shimHandlers(fn handler) map[string]handler {
	return map[string]handler{shimToolName: fn}
}

func TestShimExecWithEnvOverride(t *testing.T) {
	_, _, env := shimFixture(t, `{}`)
	h := newHost(t, shimHandlers(func(args []json.RawMessage) (any, error) {
		return map[string]any{"exec": map[string]any{"env": map[string]string{"TOKEN": "s3cret"}}}, nil
	}))
	r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir, "TOKEN=old"), "", "fake", "a", "b c")
	if r.code != 0 || r.stdout != "argv=a b c\ntok=s3cret\n" {
		t.Fatalf("%+v", r)
	}
	var call shimCall
	json.Unmarshal(h.callsTo(shimToolName)[0].Args[0], &call)
	if call.Name != "fake" || len(call.Argv) != 2 || call.Argv[1] != "b c" || call.Cwd == "" || call.Stdin != "" {
		t.Fatalf("%+v", call)
	}
}

func TestShimExecArgvRewrite(t *testing.T) {
	_, _, env := shimFixture(t, `{}`)
	h := newHost(t, shimHandlers(func(args []json.RawMessage) (any, error) {
		return map[string]any{"exec": map[string]any{"argv": []string{"--safe", "x"}}}, nil
	}))
	r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "", "fake", "rm", "-rf")
	if r.code != 0 || r.stdout != "argv=--safe x\ntok=\n" {
		t.Fatalf("%+v", r)
	}
}

func TestShimExecExitCodePropagates(t *testing.T) {
	_, _, env := shimFixture(t, `{}`)
	h := newHost(t, shimHandlers(func(args []json.RawMessage) (any, error) {
		return map[string]any{"exec": map[string]any{"env": map[string]string{"CODE": "7"}, "stdin": ""}}, nil
	}))
	r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "", "fake")
	if r.code != 7 {
		t.Fatalf("%+v", r)
	}
}

func TestShimReplyWithExitAndStderr(t *testing.T) {
	_, _, env := shimFixture(t, `{}`)
	h := newHost(t, shimHandlers(func(args []json.RawMessage) (any, error) {
		return map[string]any{"exit": 126, "stdout": "out\n", "stderr": "fake: no\n"}, nil
	}))
	r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "", "fake")
	if r.code != 126 || r.stdout != "out\n" || r.stderr != "fake: no\n" {
		t.Fatalf("%+v", r)
	}
}

func TestShimReplyBase64(t *testing.T) {
	_, _, env := shimFixture(t, `{}`)
	h := newHost(t, shimHandlers(func(args []json.RawMessage) (any, error) {
		return map[string]any{"exit": 0, "stdout": "ignored", "stdoutB64": "AP8K"}, nil
	}))
	r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "", "fake")
	if r.stdout != "\x00\xff\n" {
		t.Fatalf("%q", r.stdout)
	}
}

func TestShimLocalFastPath(t *testing.T) {
	_, _, env := shimFixture(t, `{"fake":{"local":{"store":{"exit":0},"erase":{"exit":4,"stdout":"o","stderr":"e"}}}}`)
	h := newHost(t, shimHandlers(func(args []json.RawMessage) (any, error) {
		return map[string]any{"exit": 9}, nil
	}))
	r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "", "fake", "erase")
	if r.code != 4 || r.stdout != "o" || r.stderr != "e" {
		t.Fatalf("%+v", r)
	}
	if r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "", "fake", "store"); r.code != 0 {
		t.Fatalf("%+v", r)
	}
	if n := len(h.callsTo(shimToolName)); n != 0 {
		t.Fatalf("local entries made %d calls", n)
	}
	if r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "", "fake", "get"); r.code != 9 {
		t.Fatalf("non-local args still call home: %+v", r)
	}
}

func TestShimFailsOpenWithoutToolsDir(t *testing.T) {
	_, _, env := shimFixture(t, `{}`)
	r := execute(t, append(env, "INNGEST_TOOLS_DIR="), "", "fake", "x")
	if r.code != 0 || r.stdout != "argv=x\ntok=\n" {
		t.Fatalf("%+v", r)
	}
}

func TestShimCommandNotFound(t *testing.T) {
	_, _, env := shimFixture(t, `{}`)
	h := newHost(t, shimHandlers(func(args []json.RawMessage) (any, error) {
		return map[string]any{"exec": map[string]any{}}, nil
	}))
	r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "", "missingprog")
	if r.code != 127 || r.stderr != "missingprog: command not found\n" {
		t.Fatalf("%+v", r)
	}
}

func TestShimDoesNotRunItself(t *testing.T) {
	shims, _, env := shimFixture(t, `{}`)
	os.Symlink(binPath, filepath.Join(shims, "bin", "fake"))
	h := newHost(t, shimHandlers(func(args []json.RawMessage) (any, error) {
		return map[string]any{"exec": map[string]any{}}, nil
	}))
	r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "", "inngest-tool", "shim", "fake", "q")
	if r.code != 0 || r.stdout != "argv=q\ntok=\n" {
		t.Fatalf("explicit shim subcommand: %+v", r)
	}
}

func TestShimToolError(t *testing.T) {
	_, _, env := shimFixture(t, `{}`)
	h := newHost(t, map[string]handler{})
	r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "", "fake")
	if r.code != 125 || !strings.HasPrefix(r.stderr, "fake: Unknown tool") {
		t.Fatalf("%+v", r)
	}
}

func TestShimBadReply(t *testing.T) {
	_, _, env := shimFixture(t, `{}`)
	for _, reply := range []any{"text", nil, map[string]any{}, map[string]any{"exit": 1, "exec": map[string]any{}}, map[string]any{"exit": 300}} {
		h := newHost(t, shimHandlers(func(args []json.RawMessage) (any, error) { return reply, nil }))
		r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "", "fake")
		if r.code != 125 || r.stderr != "fake: bad reply from the host\n" {
			t.Fatalf("%v: %+v", reply, r)
		}
	}
}

func TestShimStdinSentAndOverridden(t *testing.T) {
	_, _, env := shimFixture(t, `{"fake":{"stdin":true}}`)
	h := newHost(t, shimHandlers(func(args []json.RawMessage) (any, error) {
		return map[string]any{"exec": map[string]any{"stdin": "from host\n", "env": map[string]string{"READ": "1"}}}, nil
	}))
	r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "protocol=https\n", "fake", "get")
	if r.code != 0 || r.stdout != "argv=get\ntok=\nfrom host\n" {
		t.Fatalf("%+v", r)
	}
	var call shimCall
	json.Unmarshal(h.callsTo(shimToolName)[0].Args[0], &call)
	if call.Stdin != "protocol=https\n" {
		t.Fatalf("stdin sent: %q", call.Stdin)
	}
}

func TestShimStdinNotReadByDefault(t *testing.T) {
	_, _, env := shimFixture(t, `{}`)
	h := newHost(t, shimHandlers(func(args []json.RawMessage) (any, error) {
		return map[string]any{"exit": 0}, nil
	}))
	execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "ignored", "fake")
	var call shimCall
	json.Unmarshal(h.callsTo(shimToolName)[0].Args[0], &call)
	if call.Stdin != "" {
		t.Fatalf("%q", call.Stdin)
	}
}

func TestShimReplaysDrainedStdinWhenNotOverridden(t *testing.T) {
	_, _, env := shimFixture(t, `{"fake":{"stdin":true}}`)
	h := newHost(t, shimHandlers(func(args []json.RawMessage) (any, error) {
		return map[string]any{"exec": map[string]any{"env": map[string]string{"READ": "1"}}}, nil
	}))
	r := execute(t, append(env, "INNGEST_TOOLS_DIR="+h.dir), "typed by the user\n", "fake")
	if r.code != 0 || r.stdout != "argv=\ntok=\ntyped by the user\n" {
		t.Fatalf("%+v", r)
	}
}

func TestShimsListsWhatIsShimmed(t *testing.T) {
	shims := t.TempDir()
	os.WriteFile(filepath.Join(shims, "shims.txt"), []byte("fly: runs with FLY_API_TOKEN set by the host"), 0o644)
	r := execute(t, []string{"INNGEST_SHIMS_DIR=" + shims}, "", "", "shims")
	if r.code != 0 || r.stdout != "fly: runs with FLY_API_TOKEN set by the host\n" {
		t.Fatalf("%+v", r)
	}
	r = execute(t, nil, "", "", "shims")
	if r.code != 0 || r.stdout != "no shims\n" {
		t.Fatalf("%+v", r)
	}
}
