package main

import (
	"fmt"
	"io"
	"os"
)

// race checks upstream completions for honesty: reads a response body on
// stdin (or a file argument) and reports whether it is a valid completion.
func main() {
	var body []byte
	var err error
	if len(os.Args) > 1 {
		body, err = os.ReadFile(os.Args[1])
	} else {
		body, err = io.ReadAll(os.Stdin)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "race:", err)
		os.Exit(2)
	}
	if validCompletion(200, body) {
		fmt.Println("valid completion")
		return
	}
	fmt.Println("invalid completion")
	os.Exit(1)
}
