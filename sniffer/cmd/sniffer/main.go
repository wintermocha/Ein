package main

import (
	"ein.local/sniffer/internal/app"
	"fmt"
	"os"
)

func main() {
	if err := app.Run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "sniffer:", err)
		os.Exit(1)
	}
}
