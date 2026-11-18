//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// prepareConsole settles which console this process and everything it starts will use.
//
// A GUI program run from a terminal is not attached to that terminal, so `DutyBoard.exe --version`
// typed at a prompt would print nothing. As a command whose output is not going to a pipe or a file,
// it joins the terminal it was started from; in every other case — the app itself, or a command
// whose output is piped, as the agent bridge's is — it takes a console with no window.
func prepareConsole(command bool) error {
	if command && !redirected(syscall.Stdout) && attachParent() {
		return nil
	}
	return hiddenConsole()
}

// redirected reports whether h goes to a pipe or a file: somewhere the caller chose, to be left alone.
func redirected(h syscall.Handle) bool {
	if h == 0 || h == syscall.InvalidHandle {
		return false
	}
	t, err := syscall.GetFileType(h)
	return err == nil && (t == syscall.FILE_TYPE_PIPE || t == syscall.FILE_TYPE_DISK)
}

// attachParent joins the console of the process that started this one, and points the output
// streams that have nowhere to go at it. Input is left alone: the shell did not wait for a GUI
// program, so it is reading the same keyboard, and a question asked there would be answered by
// whichever of the two read first. Commands that ask questions belong to the `dutyboard` CLI.
func attachParent() bool {
	const attachParentProcess = ^uintptr(0)
	k32 := syscall.NewLazyDLL("kernel32.dll")
	if r, _, _ := k32.NewProc("AttachConsole").Call(attachParentProcess); r == 0 {
		return false
	}
	setStd := k32.NewProc("SetStdHandle")
	const stdOutput, stdError = ^uintptr(10), ^uintptr(11) // STD_OUTPUT_HANDLE -11, STD_ERROR_HANDLE -12
	// A stream is usable as it is when it is redirected, or is a console handle that works now that
	// there is a console; anything else — none at all, or one that was never valid here — is replaced.
	usable := func(h syscall.Handle) bool {
		if redirected(h) {
			return true
		}
		var mode uint32
		return h != 0 && h != syscall.InvalidHandle && syscall.GetConsoleMode(h, &mode) == nil
	}
	if !usable(syscall.Stdout) {
		if f, err := os.OpenFile("CONOUT$", os.O_RDWR, 0); err == nil {
			os.Stdout = f
			syscall.Stdout = syscall.Handle(f.Fd())
			_, _, _ = setStd.Call(stdOutput, f.Fd())
		}
	}
	if !usable(syscall.Stderr) {
		if f, err := os.OpenFile("CONOUT$", os.O_RDWR, 0); err == nil {
			os.Stderr = f
			syscall.Stderr = syscall.Handle(f.Fd())
			_, _, _ = setStd.Call(stdError, f.Fd())
		}
	}
	return true
}

// hiddenConsole gives this process a console that has no window, for everything it starts to
// inherit.
//
// The app is a GUI program, so it has no console, and Windows gives each console program started
// from one — git, gh, taskkill, the agent CLIs — a new console of its own, in a window. The CLI's
// service never showed that because its launcher runs it under a hidden cmd, whose console the
// daemon's children share. A program started with CREATE_NO_WINDOW has a console without a window,
// and attaching to that gives this process the same thing; the console outlives the helper for as
// long as anything is attached to it.
func hiddenConsole() error {
	comspec := os.Getenv("ComSpec")
	if comspec == "" {
		comspec = "cmd.exe"
	}
	helper := exec.Command(comspec, "/d", "/c", "pause")
	helper.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	stdin, err := helper.StdinPipe()                                     // pause waits on this, so the helper lives until it is closed
	if err != nil {
		return err
	}
	if err := helper.Start(); err != nil {
		return err
	}
	defer func() { stdin.Close(); _ = helper.Wait() }()
	// The helper's console exists once it has started up, which is a moment after Start returns.
	attach := syscall.NewLazyDLL("kernel32.dll").NewProc("AttachConsole")
	var e error
	for i := 0; i < 100; i++ {
		var r uintptr
		if r, _, e = attach.Call(uintptr(helper.Process.Pid)); r != 0 {
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fmt.Errorf("AttachConsole: %v", e)
}
