// Unit tests for id claiming, reply parsing, environment merging and PATH lookup, plus an opt-in per-call timing.
package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClaimIDSkipsTaken(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "id.1"), 0o755)
	os.Mkdir(filepath.Join(dir, "id.2"), 0o755)
	id, err := claimID(dir)
	if err != nil || id != 3 {
		t.Fatalf("%d %v", id, err)
	}
}

func TestParseReply(t *testing.T) {
	v, err := parseReply([]byte(`{"op":"reply","id":1,"result":{"a":1}}`))
	if err != nil || string(v) != `{"a":1}` {
		t.Fatalf("%s %v", v, err)
	}
	_, err = parseReply([]byte(`{"op":"reply","id":1,"error":"no \"x\""}`))
	if te, ok := err.(*toolError); !ok || te.message != `no "x"` {
		t.Fatalf("%v", err)
	}
	// A result that merely contains the text "error": is still a result.
	v, err = parseReply([]byte(`{"op":"reply","id":1,"result":"say \"error\":"}`))
	if err != nil || string(v) != `"say \"error\":"` {
		t.Fatalf("%s %v", v, err)
	}
}

func TestMergedEnvOverrides(t *testing.T) {
	t.Setenv("A_VAR", "old")
	env := mergedEnv(map[string]string{"A_VAR": "new", "B_VAR": "b"})
	var a, b int
	for _, kv := range env {
		if kv == "A_VAR=new" {
			a++
		}
		if kv == "B_VAR=b" {
			b++
		}
		if kv == "A_VAR=old" {
			t.Fatal("old value kept")
		}
	}
	if a != 1 || b != 1 {
		t.Fatal(env)
	}
}

func TestFindRealSkipsShimsDir(t *testing.T) {
	shims, real := t.TempDir(), t.TempDir()
	os.Mkdir(filepath.Join(shims, "bin"), 0o755)
	os.WriteFile(filepath.Join(shims, "bin", "p"), []byte("#!/bin/sh\n"), 0o755)
	os.WriteFile(filepath.Join(real, "p"), []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("INNGEST_SHIMS_DIR", shims)
	t.Setenv("PATH", filepath.Join(shims, "bin")+"/:"+real)
	if got := findReal("p"); got != filepath.Join(real, "p") {
		t.Fatal(got)
	}
	t.Setenv("PATH", filepath.Join(shims, "bin"))
	if got := findReal("p"); got != "" {
		t.Fatal(got)
	}
}

func TestPerCallFloor(t *testing.T) {
	if os.Getenv("BENCH") == "" {
		t.Skip("set BENCH=1 to time 100 sequential calls")
	}
	h := newHost(t, echoHandlers())
	const n = 100
	start := time.Now()
	for i := 0; i < n; i++ {
		if r := execute(t, toolEnv(h), "", "", "echo", "x"); r.code != 0 || !strings.Contains(r.stdout, "x") {
			t.Fatal(r)
		}
	}
	total := time.Since(start)
	t.Logf("%d sequential calls: %v total, %v per call", n, total, total/n)
}
