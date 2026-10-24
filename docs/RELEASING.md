# Releasing

`.github/workflows/release.yml` builds:

| Runner | Files |
|---|---|
| `macos-latest` | `.app` and `.dmg`, universal (Apple silicon and Intel) |
| `ubuntu-22.04` | `.AppImage`, `.deb`, `.rpm` |

## Make a release

1. Set the same version in these 3 files:
   - `src-tauri/tauri.conf.json` (`version`)
   - `src-tauri/Cargo.toml`
   - `crates/sshconfig-lossless/Cargo.toml`
2. Merge that change into `main`.
3. Push a tag. It must be `v` + the version, or the workflow stops:
   ```sh
   git tag -s v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```
4. Wait for the workflow. It makes a **draft** release with the files.
5. On GitHub, open the draft, write the notes, then publish it.

## Test a build without a release

Actions > Release > Run workflow, on any branch. Or:

```sh
gh workflow run release.yml --ref <branch>
```

The files are kept as workflow artifacts (`bundles-macos-latest`,
`bundles-ubuntu-22.04`). No release is made.

## macOS signing and notarization

Without these secrets the macOS build works but is **not signed**. macOS
then blocks the app on first open. The workflow log shows a warning.

### 1. Signing certificate

You need an Apple Developer Program membership.

1. On the Mac, Keychain Access > Certificate Assistant > Request a
   Certificate From a Certificate Authority. Save the request to disk.
2. On [developer.apple.com](https://developer.apple.com/account/resources/certificates/list),
   create a **Developer ID Application** certificate from the request.
   Download it and open it, to add it to the keychain.
3. In Keychain Access, My Certificates: right-click the certificate >
   Export. Save it as `.p12` with a strong password.
4. Get the values for the secrets:
   ```sh
   base64 -i cert.p12 | pbcopy                # APPLE_CERTIFICATE
   security find-identity -v -p codesigning   # APPLE_SIGNING_IDENTITY
   ```
   The identity is the text in quotes, for example
   `Developer ID Application: Your Name (TEAMID)`.

### 2. Notarization (choose one)

**A. App Store Connect API key (recommended).** In App Store Connect >
Users and Access > Integrations > App Store Connect API, make a key with
the Developer role. Download the `.p8` file (one time only).

**B. Apple ID.** Make an app-specific password at
[account.apple.com](https://account.apple.com). Your Team ID is on the
Membership page of developer.apple.com.

### 3. Repository secrets

Settings > Secrets and variables > Actions > New repository secret.

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: ...` |
| **Option A** | |
| `APPLE_API_ISSUER` | Issuer ID (on the API keys page) |
| `APPLE_API_KEY` | Key ID |
| `APPLE_API_KEY_P8` | the full text of the `.p8` file |
| **Option B** | |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | Team ID |

If all of option A is set, the workflow uses A. A missing secret turns
off only its own step (signing or notarization), with a warning.

### 4. Check

Run the workflow by hand, download `bundles-macos-latest`, then:

```sh
codesign -dv --verbose=2 "SSH Config Manager.app"
spctl -a -vv "SSH Config Manager.app"   # "source=Notarized Developer ID"
```
