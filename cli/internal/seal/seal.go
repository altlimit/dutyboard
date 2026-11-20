// Package seal lets the console send this machine a secret that nothing in between can read.
//
// The machine makes a P-256 key pair once and keeps the private half in its keyring. It publishes
// the public half with its readiness report. A browser encrypts to that key — an ephemeral ECDH
// key, HKDF-SHA256, AES-256-GCM, all of it WebCrypto — and what travels through the board and sits
// in its datastore until this machine takes it is ciphertext only this machine can open.
//
// That is what makes it acceptable for a long-lived credential, such as an MCP server's API token,
// to be typed in the console at all. A sign-in code can pass through the board because it is
// single-use and worthless on its own; a token is neither.
package seal

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/altlimit/dutyboard/cli/internal/state"
)

// keyName is the credential the machine's private key is kept under.
const keyName = "seal-key"

// context binds a key to this use and this version of the envelope, on both sides.
const context = "dutyboard-seal-v1"

var b64 = base64.RawURLEncoding

// privateKey is this machine's key, made and stored on first use.
func privateKey() (*ecdh.PrivateKey, error) {
	if stored, err := state.Credential(keyName); err == nil && stored != "" {
		raw, err := b64.DecodeString(stored)
		if err == nil {
			if key, err := ecdh.P256().NewPrivateKey(raw); err == nil {
				return key, nil
			}
		}
		// Unreadable: a new key replaces it, and the console learns the new public half.
	}
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := state.SetCredential(keyName, b64.EncodeToString(key.Bytes())); err != nil {
		return nil, fmt.Errorf("keeping this machine's sealing key: %w", err)
	}
	return key, nil
}

// PublicKey is what the console encrypts to: the uncompressed P-256 point, base64url.
func PublicKey() (string, error) {
	key, err := privateKey()
	if err != nil {
		return "", err
	}
	return b64.EncodeToString(key.PublicKey().Bytes()), nil
}

// Open decrypts an envelope the console sealed to this machine: `v1.<ephemeral key>.<nonce>.<ciphertext>`.
func Open(envelope string) ([]byte, error) {
	key, err := privateKey()
	if err != nil {
		return nil, err
	}
	return open(key, envelope)
}

func open(key *ecdh.PrivateKey, envelope string) ([]byte, error) {
	parts := strings.Split(envelope, ".")
	if len(parts) != 4 || parts[0] != "v1" {
		return nil, errors.New("not something this dutyboard can open — update it, then send it again")
	}
	var raw [3][]byte
	for i, p := range parts[1:] {
		b, err := b64.DecodeString(p)
		if err != nil {
			return nil, errors.New("the sealed value is damaged")
		}
		raw[i] = b
	}
	ephemeral, err := ecdh.P256().NewPublicKey(raw[0])
	if err != nil {
		return nil, errors.New("the sealed value is damaged")
	}
	aead, err := cipherFor(key, ephemeral)
	if err != nil {
		return nil, err
	}
	if len(raw[1]) != aead.NonceSize() {
		return nil, errors.New("the sealed value is damaged")
	}
	plain, err := aead.Open(nil, raw[1], raw[2], []byte(context))
	if err != nil {
		return nil, errors.New("it was sealed for a different key — reload the Machines page and enter it again")
	}
	return plain, nil
}

// cipherFor derives the one-time AES-256-GCM key both sides arrive at: ECDH between the machine's key
// and the ephemeral one, through HKDF bound to both public keys.
func cipherFor(key *ecdh.PrivateKey, ephemeral *ecdh.PublicKey) (cipher.AEAD, error) {
	shared, err := key.ECDH(ephemeral)
	if err != nil {
		return nil, err
	}
	info := append(append([]byte(context), key.PublicKey().Bytes()...), ephemeral.Bytes()...)
	derived, err := hkdf.Key(sha256.New, shared, nil, string(info), 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Seal encrypts to a public key the way the console does. It is here for tests and for anything on
// this side that needs to make an envelope; the console's copy is app/src/lib/seal.js.
func Seal(publicKey string, plain []byte) (string, error) {
	raw, err := b64.DecodeString(publicKey)
	if err != nil {
		return "", errors.New("not a public key")
	}
	to, err := ecdh.P256().NewPublicKey(raw)
	if err != nil {
		return "", errors.New("not a public key")
	}
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	shared, err := ephemeral.ECDH(to)
	if err != nil {
		return "", err
	}
	info := append(append([]byte(context), to.Bytes()...), ephemeral.PublicKey().Bytes()...)
	derived, err := hkdf.Key(sha256.New, shared, nil, string(info), 32)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nil, nonce, plain, []byte(context))
	return strings.Join([]string{"v1", b64.EncodeToString(ephemeral.PublicKey().Bytes()), b64.EncodeToString(nonce), b64.EncodeToString(sealed)}, "."), nil
}
