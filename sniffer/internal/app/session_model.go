package app

import (
	"slices"
	"strconv"
	"strings"
)

// A resumed conversation keeps its native selection. An explicit model on a
// fresh launch also takes precedence over the Ein default.
func sessionModelArgs(host, model string, args []string) []string {
	if host == "codex" {
		return codexSessionModelArgs(model, args)
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		flag, _, attached := strings.Cut(arg, "=")
		switch flag {
		case "--model", "--continue", "--resume", "-r", "-c":
			return args
		}
		if host == "agy" {
			switch flag {
			case "--conversation", "-conversation", "-resume", "-continue", "-model":
				return args
			case "-p", "--print", "--prompt", "-i", "--prompt-interactive", "--agent", "--add-dir", "--settings", "--project", "--log-file", "--json-schema":
				if !attached {
					i++
				}
			}
		}
	}
	return append([]string{"--model", model}, args...)
}

func codexSessionModelArgs(model string, args []string) []string {
	configAt := 0
	parentCommand := "codex"
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		flag, value, attached := strings.Cut(arg, "=")
		switch {
		case flag == "--model" || strings.HasPrefix(arg, "-m") || flag == "--oss":
			return args
		case flag == "--config" || strings.HasPrefix(arg, "-c"):
			configAt = i
			if arg == "-c" || arg == "--config" {
				i++
				if i == len(args) {
					return args
				}
				value = args[i]
			} else if flag != "--config" && flag != "-c" {
				value = strings.TrimPrefix(arg, "-c")
			}
			if key, _, ok := strings.Cut(value, "="); ok && strings.TrimSpace(key) == "model" {
				return args
			}
		case parentCommand != "" && !strings.HasPrefix(arg, "-"):
			if arg == "resume" || (arg == "fork" && parentCommand == "codex") {
				return args
			}
			if parentCommand == "codex" && (arg == "exec" || arg == "e") {
				parentCommand = "exec"
			} else {
				parentCommand = ""
			}
		case !attached:
			switch flag {
			case "-C", "--cd", "--add-dir", "-i", "--image", "-a", "--ask-for-approval", "-p", "--profile", "-s", "--sandbox",
				"--enable", "--disable", "--remote", "--remote-auth-token-env", "--local-provider", "--output-schema", "--color", "-o", "--output-last-message":
				i++
			}
		}
	}
	// Codex subcommands with their own -c ignore root-level -c options.
	// Put the default in the same scope as the last native config override.
	return slices.Concat(args[:configAt], []string{"-c", "model=" + strconv.Quote(model)}, args[configAt:])
}
