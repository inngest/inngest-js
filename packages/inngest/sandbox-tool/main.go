// Entry point: runs as the tool client, or as a command shim when invoked under another name.
package main

import (
	"os"
	"path/filepath"
)

const toolName = "inngest-tool"

func main() {
	base := filepath.Base(os.Args[0])
	if base != toolName {
		os.Exit(runShim(base, os.Args[1:]))
	}
	if len(os.Args) >= 3 && os.Args[1] == "shim" {
		os.Exit(runShim(os.Args[2], os.Args[3:]))
	}
	os.Exit(runClient(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}
