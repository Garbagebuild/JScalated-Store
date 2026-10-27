# JScalated Store sources and developer updates

OStore reads the JScalated catalogue from this repository and the OStore API.
The JScalated entries in `webapps.json` normally install through the matching
`Apps-directory/<folder>/update.webmanifest` on GitHub Pages. The catalogue
schema is `1`; each entry has a folder, name, version, category, description,
release `package_url`, and SHA-256. The update manifest's `package_path` points
to the same asset in the shared `jscalated-apps-1` GitHub Release.

## Developer-maintained updates for new apps

An app developer can maintain a stable HTTPS `update.webmanifest` in their own
repository. During onboarding, add its absolute URL as `update_url` in that
app's `webapps.json` entry. OStore uses that URL for the initial AppsManager
install, and KaiOS records it as the app's update URL. The developer can then
publish new packages and update that one manifest without editing OStore or
getting access to this repository's release assets. Existing apps without
`update_url` continue using their current JScalated URL.

For the first listing, submit a pull request containing the app's
`manifest.webmanifest`, 56×56 icon, `SOURCE.md` with the upstream repository
and distribution permission, `update.webmanifest`, and `webapps.json` entry.
The initial package still goes to the shared `jscalated-apps-1` Release, and
the local update manifest, `package_url`, and SHA-256 describe that initial
asset. The developer's own update manifest must be live before the listing is
published and should initially point to that same package. OStore only uses
the developer URL for installation; the local copy preserves the initial
release record.

After onboarding, the developer's release steps are:

1. Build a new `application.zip` with the **same** manifest `id` and
   `b2g_features.origin`, a higher version, and the required permissions.
   Prepare the package using a method accepted by the target phone.
2. Publish the ZIP as an immutable asset on their own GitHub Releases page.
3. Update the stable `update.webmanifest` URL in their own repository. Set
   `version` and `b2g_features.version` to the new version, `package_path`
   to the exact release asset URL, and `packaged_size` to its byte length.
   Keep the rest of `b2g_features` aligned with the ZIP's manifest.
4. Confirm that the manifest and release asset are publicly downloadable.
   OStore reads the developer manifest to show the current version; the
   installed app's update check uses the same URL.

The developer manifest must be served from a stable HTTPS URL without a query
string or fragment. It must allow OStore to read it across origins, such as
through GitHub Pages. A new release should use a new asset name or tag so
cached ZIP bytes cannot be confused with an earlier release. The first release
and the onboarding PR still need review and device testing.

KaiOS retains the update URL used at install time. An app already installed
from this repository's update URL will continue using it; changing its
catalogue entry to a developer URL does not migrate that installed record.
Use developer-maintained URLs for newly listed apps, or plan a separate
migration for existing installs.

## Hosted PWA listings

A developer who already hosts a KaiOS app can provide a public HTTPS
`manifest.webmanifest` instead of a ZIP. Its catalogue entry uses `type: "pwa"`,
the manifest's exact `id`, `manifest_url`, and `source_url`. It has no
`package_url`, SHA-256, `application.zip`, or local `update.webmanifest`.
The folder holds a 56×56 icon and `SOURCE.md` with credit and permission.
OStore loads the owner's manifest to show the current version and calls
`AppsManager.installPwa` with its URL. The hosted app's content and schedule
are maintained by its owner; no new Store package is needed for those changes.

The manifest must permit cross-origin reads from OStore. Check it from the
target device before claiming installation works there. A browser test or a
separate `appscmd install-pwa` test does not prove the OStore AppsManager path.

The packages prepared in this project pass the tested KaiOS package verifier,
but their CMS signatures are not cryptographically valid. Phone acceptance and
individual app compatibility require device testing.

## OStore handoff

The catalogue now lists OStore 1.2.9 in place of the older JScalated Store app.
The [GitHub Pages installer](https://garbagebuild.github.io/JScalated-Store/)
stages the OStore AppsManager helper directly on the phone.
Its update source is
`https://garbagebuild.github.io/JScalated-Store/Apps-directory/OStore/update.webmanifest`.
The JScalated Store update manifest remains in this repository for phones that
already installed that app. Removing its catalogue entry does not uninstall it.

OStore uses its recorded update URL to check for its own updates. A fresh install
through the GitHub Pages update manifest will check this HTTPS source on later
launches. An OStore installation originally made from a LAN update URL may
continue checking that old URL; migration of that installed record has not
been verified on a handset. The OStore ZIP here contains copied CMS signature
metadata from the Python fixture tool, not a genuine cryptographic signature.
