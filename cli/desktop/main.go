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
	// The app's own arguments, which are how "start when I sign in" launches it: --tray starts it in
	// the tray with no window, and --home says which home, because a sign-in entry carries no
	// environment. Anything else is a `dutyboard` command.
	startHidden, quit, home, mine := false, false, "", len(args) > 0
	for i := 0; i < len(args) && mine; i++ {
		switch {
		case args[i] == "--tray":
			startHidden = true
		case args[i] == "--quit":
			// Asks the app that is running to quit, and is not one itself: how an installer gets it
			// out of the way before replacing or removing it.
			quit = true
		case args[i] == "--home" && i+1 < len(args):
			home = args[i+1]
			i++
		default:
			mine = false
		}
	}
	if len(args) > 0 && !mine {
		// As a command: what it prints goes to the terminal it was typed in.
		_ = prepareConsole(true)
		os.Exit(app.Main(args))
	}
	if home != "" {
		_ = os.Setenv("DUTYBOARD_HOME", home)
	}
	// Coming back from an update nobody asked for by hand: the way it was, in the tray. The variable is
	// left set, because the process reading it first is not the app but the helper that swaps the
	// files and then starts the app, which inherits it from there. Updates.restart sets or clears it
	// each time, so it never outlives the restart it was meant for.
	if os.Getenv(hiddenEnv) != "" {
		startHidden = true
	}
	if quit {
		os.Exit(runApp(true, true, nil))
	}
	// Before anything starts a child.
	os.Exit(runApp(startHidden, false, prepareConsole(false)))
}
