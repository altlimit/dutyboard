package app

import (
	"net/url"
	"os"
	"strings"

	"github.com/altlimit/dutyboard/cli/internal/ui"
)

// A DutyBoard is deployed and upgraded from its manifest, by whoever opens the deploy link: they sign
// in to altengine, pick an organization, see every instance it creates or changes, and deploy it as
// themselves. Nothing on a machine holds a key to do it. Each release's manifest, function and
// console are published by the release workflow (scripts/build-deploy.mjs).

// deployBase is where each release's deploy folder is published; latest/ is the newest.
func deployBase() string {
	if v := os.Getenv("DUTYBOARD_DEPLOY_BASE"); v != "" {
		return strings.TrimRight(v, "/") + "/"
	}
	return "https://www.dutyboard.com/deploy/"
}

// altengineConsole is where the deploy page is.
func altengineConsole() string {
	if v := os.Getenv("ALTENGINE_CONSOLE_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "https://console.altengine.net"
}

// ManifestURL is the newest release's manifest. A deployment made from it upgrades from the same
// address: altengine's "Check for updates" reads it again and gets whatever is newest then.
func ManifestURL() string { return deployBase() + "latest/altengine.json" }

// DeployLink opens the deploy page for DutyBoard. app names the deployment to upgrade — the name
// its /health reports — and "" deploys a new one, named on the page.
func DeployLink(app string) string {
	q := url.Values{"manifest": {ManifestURL()}}
	if app != "" {
		q.Set("name", app)
	}
	return altengineConsole() + "/deploy?" + q.Encode()
}

// showDeployLink says where to deploy or upgrade, and opens it.
func showDeployLink(u *ui.UI, link string, open func(string) error) {
	u.Say("Open %s", link)
	if open == nil {
		open = openBrowser
	}
	if !browserless() {
		_ = open(link)
	}
}
