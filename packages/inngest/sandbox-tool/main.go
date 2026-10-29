// Entry point: runs as the tool client, or as a command shim when invoked under another name.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
	if len(os.Args) == 2 && os.Args[1] == "shims" {
		os.Exit(listShims())
	}
	os.Exit(runClient(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// listShims prints what the command's shims do, one "name: description" line each.
func listShims() int {
	dir := os.Getenv("INNGEST_SHIMS_DIR")
	if dir == "" {
		fmt.Println("no shims")
		return 0
	}
	data, err := os.ReadFile(filepath.Join(dir, "shims.txt"))
	if err != nil {
		fmt.Println("no shims")
		return 0
	}
	fmt.Println(strings.TrimRight(string(data), "\n"))
	return 0
}
