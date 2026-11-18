//go:build !windows

package main

// sameSigner has nothing to compare where the app is not signed by the system's own scheme.
func sameSigner(string) error { return nil }
