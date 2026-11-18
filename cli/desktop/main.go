// DutyBoard for the desktop: the same dutyboard, as an app that lives in the system tray.
//
// With no arguments it is the app, and the app is the machine: it runs the daemon itself, and closing
// its window leaves it working in the tray. With arguments it is `dutyboard` exactly — which it has to
// be, because the daemon starts its own executable as `<exe> mcp` for each agent session.
package main

import (
	"os"

	"github.com/altlimit/dutyboard/cli/internal/app"
)

func main() {
	args := os.Args[1:]
	startHidden := len(args) == 1 && args[0] == "--tray" // how "start when I sign in" launches it
	if len(args) > 0 && !startHidden {
		// As a command: what it prints goes to the terminal it was typed in.
		_ = prepareConsole(true)
		os.Exit(app.Main(args))
	}
	// Before anything starts a child.
	os.Exit(runApp(startHidden, prepareConsole(false)))
}
