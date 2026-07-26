# macOS packaging, signing, and Homebrew

The menu bar companion currently has two distinct distribution levels. Keep
their claims separate:

| Artifact | Signature | Intended use | Public release? |
| --- | --- | --- | --- |
| `npm run build:menubar` | Ad-hoc | Local development and personal installation | No |
| Developer ID build | Developer ID Application, hardened runtime, secure timestamp, Apple notarization ticket | Downloadable release and Homebrew cask | Yes, after every verification below passes |

An ad-hoc signature proves bundle integrity after the local build. It does not
establish a publisher identity, satisfy Gatekeeper for public downloads, or
replace notarization.

## Credential-free packaging proof

The manual **macOS package proof** workflow in
`.github/workflows/macos-package-proof.yml`:

1. installs dependencies on a macOS runner;
2. builds the existing ad-hoc-signed application;
3. validates its property list and code signature;
4. packages it with `ditto`;
5. extracts the ZIP and verifies the packaged app's signature again;
6. generates a SHA-256 checksum;
7. uploads the ZIP and checksum as a short-lived workflow artifact.

It never creates a GitHub Release, updates Homebrew, or claims that the artifact
is notarized. It needs no Apple certificate or repository secret and is safe to
run from a fork.

## Local verification

```bash
npm ci
npm run build:menubar

APP="dist/AI Usage Dashboard Menu Bar.app"
plutil -lint "$APP/Contents/Info.plist"
xattr -cr "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
```

Finder or a file provider can attach `com.apple.FinderInfo` after a successful
build. Clearing non-code extended attributes before verification prevents that
metadata from being mistaken for signed bundle content. If verification still
fails after the cleanup, rebuild the app; do not ignore or suppress the result.

Run the collector, launch the built app, and verify the menu label, provider
popover, manual refresh, and launch-at-login control before preparing a release.

## Developer ID release gate

Public distribution requires Apple Developer Program access and a
**Developer ID Application** certificate. Apple requires Developer ID-signed
code, hardened runtime, and a secure timestamp for the standard notarization
path. Follow Apple's
[notarization documentation](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
as the authority when it differs from this checklist.

The current build script always applies an ad-hoc signature. Before automating a
public release, extend it with an explicit distribution mode rather than
silently replacing the local behavior. The distribution mode should:

1. remove extended attributes before signing;
2. sign any nested executable code first, then the application bundle;
3. use `codesign --options runtime --timestamp` with a Developer ID Application
   identity;
4. verify the signed bundle before uploading it;
5. package the submission with `ditto --norsrc -c -k --keepParent`;
6. submit with `xcrun notarytool ... --wait`;
7. inspect the notary log, staple the accepted ticket, and validate it;
8. create a fresh ZIP from the stapled app and generate a SHA-256 checksum;
9. download the published ZIP into a clean location and test that exact
   artifact.

Representative verification commands:

```bash
APP="dist/AI Usage Dashboard Menu Bar.app"

codesign --verify --deep --strict --verbose=2 "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP"
```

Do not put a certificate, private key, App Store Connect key, notary password,
or base64-encoded credential in the repository. For local releases, store
notary credentials in Keychain through `notarytool`. For CI, use protected
repository or environment secrets and restrict release jobs to trusted tags.

## Architecture support

The current `npm run build:menubar` output targets the runner's host
architecture. Do not label an archive “universal” until the build produces both
`arm64` and `x86_64` slices and `lipo -archs` verifies them. A universal release
requires building both slices, combining the executable, packaging the final
bundle, and only then performing Developer ID signing and notarization.

If separate architecture downloads are published instead, the GitHub asset
names, checksums, and Homebrew cask must select the correct archive explicitly.

## Release checklist

- [ ] `package.json` and `Info.plist` show the intended version.
- [ ] CI and the macOS package proof pass from a clean checkout.
- [ ] The application is built for every architecture named in the asset.
- [ ] Developer ID signing uses hardened runtime and a secure timestamp.
- [ ] `codesign`, `stapler`, and `spctl` validations pass.
- [ ] The final ZIP contains the stapled app and has a published SHA-256.
- [ ] The downloaded GitHub Release asset, not the local staging bundle, launches.
- [ ] Release notes describe user-visible changes and known limitations.
- [ ] Only after the GitHub asset is final is the Homebrew cask checksum updated.

## Homebrew cask

Start with a project-owned tap while releases are young. Write the cask from the
official [Homebrew Cask Cookbook](https://docs.brew.sh/Cask-Cookbook); do not
copy another project's unlicensed tap file.

The cask should have:

- a versioned GitHub Release URL;
- the exact SHA-256 of the final notarized ZIP;
- `depends_on macos: :sonoma`, matching the application's macOS 14 minimum;
- `app "AI Usage Dashboard Menu Bar.app"`;
- a conservative `zap` list containing only this application's preferences and
  support paths.

Test from a clean tap:

```bash
brew audit --cask --strict ai-usage-dashboard
brew install --cask your-org/tap/ai-usage-dashboard
open -a "AI Usage Dashboard Menu Bar"
```

Homebrew publication is complete only when a fresh install downloads the exact
notarized asset, its checksum matches, the application launches, and uninstall
does not remove unrelated user data.

## CodexBar research boundary

The release ordering above was informed by CodexBar's MIT-licensed
[`sign-and-notarize.sh`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Scripts/sign-and-notarize.sh)
and
[`RELEASING.md`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/docs/RELEASING.md),
then reduced to this project's single-executable bundle. No signing identity,
credential, Sparkle key, provider helper, or CodexBar release script is copied.
See [Attribution and provenance](attribution.md#codexbar-implementation-review).
