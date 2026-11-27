package app

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"ein.local/sniffer/internal/config"
	"ein.local/sniffer/internal/host"
	"ein.local/sniffer/internal/model"
	"ein.local/sniffer/internal/native"
	"ein.local/sniffer/internal/worker"
)

type ready struct {
	Endpoint   string `json:"endpoint"`
	RunID      string `json:"run_id"`
	AgentReady bool   `json:"agent_ready"`
}

func (a app) doctor(args []string) error {
	f := a.flags("doctor")
	h := f.String("host", "", "claude, codex, or agy")
	executable := f.String("executable", "", "CLI executable path")
	configure := f.Bool("configure", false, "save an explicitly selected executable after local capability checks")
	if err := parse(f, args); err != nil {
		return err
	}
	name, err := host.Canonical(*h)
	if err != nil {
		return err
	}
	c, err := config.Load(a.paths)
	if err != nil {
		return err
	}
	j := c.Agents[name]
	if *executable != "" {
		j.Executable = *executable
	}
	resolved, err := exec.LookPath(j.Executable)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	version, versionErr := exec.CommandContext(ctx, resolved, "--version").Output()
	if len(version) > 4096 {
		version = version[:4096]
	}
	probeArgs := []string{"--help"}
	if name == "codex" {
		probeArgs = []string{"app-server", "--help"}
	}
	help, probeErr := exec.CommandContext(ctx, resolved, probeArgs...).Output()
	if len(help) > 256*1024 {
		return errors.New("CLI help output exceeded probe budget")
	}
	checks := map[string]bool{"version_command": versionErr == nil, "help_command": probeErr == nil}
	switch name {
	case "claude":
		checks["plugin_dir_flag"] = strings.Contains(string(help), "--plugin-dir")
		_, e := os.Stat(filepath.Join(a.paths.Adapters, "claude-mod", ".claude-plugin", "plugin.json"))
		checks["mod_installed"] = e == nil
	case "codex":
		checks["app_server"] = probeErr == nil && strings.Contains(string(help), "app-server")
	case "agy":
		for _, flag := range []string{"--input-format", "--output-format", "--agent", "--json-schema"} {
			checks[flag] = strings.Contains(string(help), flag)
		}
	}
	ready := true
	for _, ok := range checks {
		ready = ready && ok
	}
	if *configure && ready {
		j.Executable = resolved
		if err = config.Update(a.paths, func(cfg *config.Config) error { cfg.Agents[name] = j; return nil }); err != nil {
			return err
		}
	}
	if err = a.json(map[string]any{"host": name, "executable": resolved, "version": strings.TrimSpace(string(version)), "local_capabilities_ready": ready, "checks": checks, "memory_model": native.Model(name), "live_model_tested": false, "note": "Local capability checks only. Native protocol, model access and policy are checked again when the memory conversation starts."}); err != nil {
		return err
	}
	if !ready {
		return errors.New("one or more local capability checks failed; see report")
	}
	return nil
}

func (a app) serve(args []string) error {
	f := a.flags("worker")
	h := f.String("host", "", "host")
	pid := f.String("project", "", "project ID")
	run := f.String("run-id", "", "run ID")
	ownerFD := f.Int("owner-fd", -1, "inherited owner connection")
	if err := parse(f, args); err != nil {
		return err
	}
	if err := required("--host", *h, "--project", *pid, "--run-id", *run); err != nil {
		return err
	}
	if *ownerFD < 3 || !config.ValidID(*run) {
		return errors.New("worker requires a launcher-owned pipe")
	}
	name, err := host.Canonical(*h)
	if err != nil {
		return err
	}
	if name == "claude" {
		return errors.New("Claude uses its native mod and standalone bridge; no worker is required")
	}
	c, err := config.Load(a.paths)
	if err != nil {
		return err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	binding, err := a.bindProject(*pid, cwd, false)
	if err != nil {
		return err
	}
	runDir := filepath.Join(a.paths.Run, *run)
	defer os.RemoveAll(runDir)
	tokenPath := filepath.Join(runDir, "token")
	st, err := os.Lstat(tokenPath)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm() != 0600 {
		return errors.New("invalid worker token file")
	}
	token, err := os.ReadFile(tokenPath)
	if err != nil {
		return err
	}
	if len(token) != 64 {
		return errors.New("invalid worker token length")
	}
	owner := os.NewFile(uintptr(*ownerFD), "sniffer-owner")
	if owner == nil {
		return errors.New("missing owner pipe")
	}
	defer owner.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGHUP, syscall.SIGINT)
	defer cancel()
	go func() { _, _ = io.Copy(io.Discard, owner); cancel() }()
	self, err := os.Executable()
	if err != nil {
		return err
	}
	factory := func(conversation string) (native.Session, error) {
		hash := sha256.Sum256([]byte(name + "\x00" + conversation))
		dir := filepath.Join(runDir, "agents", hex.EncodeToString(hash[:]))
		return native.New(native.Config{Host: name, Executable: c.Agents[name].Executable, Agent: c.Agents[name].Agent, Cwd: cwd, RuntimeDir: dir, SnifferExecutable: self, EinHome: a.paths.Home, ProjectID: *pid})
	}
	engine := worker.New(ctx, a.paths, c, name, *pid, *run, func(ctx context.Context) (model.Snapshot, error) { return a.projectSnapshot(ctx, binding) }, factory)
	defer engine.Close()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	server := &http.Server{Handler: engine.Handler(string(token)), ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 3 * time.Second, WriteTimeout: 8 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 8192}
	errCh := make(chan error, 1)
	go func() { errCh <- server.Serve(listener) }()
	if err = json.NewEncoder(a.out).Encode(ready{Endpoint: "http://" + listener.Addr().String(), RunID: *run, AgentReady: true}); err != nil {
		cancel()
		_ = server.Close()
		return err
	}
	select {
	case <-ctx.Done():
		shutdownCtx, done := context.WithTimeout(context.Background(), 2*time.Second)
		defer done()
		_ = server.Shutdown(shutdownCtx)
		return nil
	case err = <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

const delegationGuide = `For ordinary delegated agents that need Ein memory, run "$EIN_SNIFFER_BIN" delegate [--cwd DIR] [--project ID] -- COMMAND ARG... from the parent's bound workspace. Omit --project to inherit the parent project. Select another project only when the task explicitly assigns it. For a native spawn API, omit the command to get JSON and apply workingDirectory and env together after removing inherited EIN_SNIFFER_* settings and Slack tokens. Never pass the parent's worker endpoint, token file or memory tools to a child. If the host cannot apply the binding, give the child only the relevant context retrieved by the parent with direct Sniffer tools disabled. Where a child environment can be set, use EIN_SNIFFER_DELEGATION=none for this context-only mode. If the host cannot isolate a child from direct Sniffer access, keep the work in the parent. This applies to task agents; the private read-only Sniffer helper is managed by the host.`

func (a app) launch(args []string) error {
	if len(args) == 0 {
		return errors.New("run requires claude, codex, or agy")
	}
	name, err := host.Canonical(args[0])
	if err != nil {
		return err
	}
	nativeArgs := args[1:]
	if len(nativeArgs) > 0 && nativeArgs[0] == "--" {
		nativeArgs = nativeArgs[1:]
	}
	c, err := config.Load(a.paths)
	if err != nil {
		return err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	binding, err := a.bindProject("", cwd, false)
	if err != nil {
		return err
	}
	pid := binding.id
	if _, err = a.projectSnapshot(context.Background(), binding); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	self, err = filepath.EvalSymlinks(self)
	if err != nil {
		return err
	}
	native, err := exec.LookPath(c.Agents[name].Executable)
	if err != nil {
		return err
	}
	configPath, err := config.EinConfigPath()
	if err != nil {
		return err
	}
	childEnv := append(cleanSnifferEnv(os.Environ()), "EIN_CONFIG="+configPath, expectedProjectEnv+"="+pid)
	if name == "claude" {
		mod := filepath.Join(a.paths.Adapters, "claude-mod")
		if _, err = os.Stat(filepath.Join(mod, ".claude-plugin", "plugin.json")); err != nil {
			return fmt.Errorf("install the Claude mod first: %w", err)
		}
		main := exec.Command(native, append([]string{"--plugin-dir", mod}, nativeArgs...)...)
		main.Env = append(childEnv, "EIN_HOME="+a.paths.Home, "EIN_SNIFFER_BIN="+self, "EIN_SNIFFER_DELEGATE_GUIDE="+delegationGuide)
		if raw := os.Getenv("EIN_SNIFFER_PROMPT_WAIT_MS"); raw != "" {
			if n, e := strconv.Atoi(raw); e == nil && n >= 0 && n <= 5000 {
				main.Env = append(main.Env, "EIN_SNIFFER_PROMPT_WAIT_MS="+raw)
			}
		}
		return a.runMain(main)
	}
	runID := worker.RandomID()
	runDir := filepath.Join(a.paths.Run, runID)
	if err = os.MkdirAll(runDir, 0700); err != nil {
		return err
	}
	defer os.RemoveAll(runDir)
	tokenFile := filepath.Join(runDir, "token")
	if err = config.AtomicWrite(tokenFile, []byte(worker.RandomID()+worker.RandomID()), 0600); err != nil {
		return err
	}
	ownerRead, ownerWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer ownerWrite.Close()
	cmd := exec.Command(self, "--home", a.paths.Home, "worker", "--host", name, "--project", pid, "--run-id", runID, "--owner-fd", "3")
	cmd.ExtraFiles = []*os.File{ownerRead}
	cmd.Env = childEnv
	cmd.Env = append(cmd.Env, "EIN_HOME="+a.paths.Home)
	cmd.Stderr = a.err
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		ownerRead.Close()
		return err
	}
	if err = cmd.Start(); err != nil {
		ownerRead.Close()
		return err
	}
	ownerRead.Close()
	waiter := make(chan error, 1)
	go func() { waiter <- cmd.Wait() }()
	defer func() {
		ownerWrite.Close()
		select {
		case <-waiter:
			return
		case <-time.After(4 * time.Second):
		}
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		select {
		case <-waiter:
			return
		case <-time.After(time.Second):
		}
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-waiter
	}()
	readyCh := make(chan struct {
		r   ready
		err error
	}, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1024), 8192)
		if !scanner.Scan() {
			readyCh <- struct {
				r   ready
				err error
			}{err: errors.New("worker did not become ready")}
			return
		}
		var r ready
		e := json.Unmarshal(scanner.Bytes(), &r)
		readyCh <- struct {
			r   ready
			err error
		}{r, e}
		_, _ = io.Copy(io.Discard, stdout)
	}()
	var info ready
	select {
	case result := <-readyCh:
		if result.err != nil {
			return result.err
		}
		info = result.r
	case <-time.After(40 * time.Second):
		return errors.New("worker startup timed out")
	}
	if info.RunID != runID || !strings.HasPrefix(info.Endpoint, "http://127.0.0.1:") {
		return errors.New("worker returned an invalid binding")
	}
	main := exec.Command(native, nativeArgs...)
	main.Env = append(childEnv, "EIN_HOME="+a.paths.Home, "EIN_SNIFFER_RUN_ID="+runID, "EIN_SNIFFER_ENDPOINT="+info.Endpoint, "EIN_SNIFFER_TOKEN_FILE="+tokenFile, "EIN_SNIFFER_HOST="+name, "EIN_SNIFFER_PROJECT_ID="+pid, "EIN_SNIFFER_BIN="+self)
	return a.runMain(main)
}

func (a app) runMain(main *exec.Cmd) error {
	main.Stdin = a.in
	main.Stdout = a.out
	main.Stderr = a.err
	// Keep the interactive CLI in the terminal foreground process group. The
	// product adapter closes its own memory transport when the owner exits.
	if err := main.Start(); err != nil {
		return err
	}
	mainWait := make(chan error, 1)
	go func() { mainWait <- main.Wait() }()
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	for {
		select {
		case err := <-mainWait:
			return err
		case sig := <-signals:
			if sig == os.Interrupt {
				continue
			} // The foreground CLI already received Ctrl-C.
			_ = main.Process.Signal(sig)
			select {
			case err := <-mainWait:
				return err
			case <-time.After(3 * time.Second):
				_ = main.Process.Kill()
				return <-mainWait
			}
		}
	}
}
func cleanSnifferEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, v := range env {
		if !strings.HasPrefix(v, "EIN_SNIFFER_") || v == delegationEnv+"=assigned" {
			out = append(out, v)
		}
	}
	return out
}
