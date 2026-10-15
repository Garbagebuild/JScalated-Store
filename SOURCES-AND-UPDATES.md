# JScalated Store sources and developer updates

The Store starts with the JScalated GitHub Pages catalogue. **Add source** accepts
an `http://` or `https://` directory URL, or the complete URL ending in
`webapps.json`. For example, both `https://example.com/kaios/` and
`https://example.com/kaios/webapps.json` identify the same source. The phone
saves up to eight extra sources in the Store's local storage. The host must
permit cross-origin requests for `webapps.json` and `update.webmanifest`.

Each source follows this layout:

```text
webapps.json
Apps-directory/
  Example-App/
    manifest.webmanifest
    update.webmanifest
    application.zip       # optional if package_url points to a release asset
```

The catalogue uses schema 1 with `categories` and `apps`, matching the
JScalated `webapps.json` in this project. Each app entry needs `folder`, `name`,
`version`, `category`, and `description`. `package_url` may point to an HTTPS
release asset. When it is absent, the package is expected at the app folder's
`application.zip` URL.

For a developer update:

1. Keep the app's source URL and `Apps-directory/<folder>/update.webmanifest`
   path stable. KaiOS records that URL as the installed app's `updateURL`.
2. Build a new package with the same app identity (`id` and origin), a higher
   `b2g_features.version`, and the required permissions in its
   `manifest.webmanifest`. Prepare or sign the package using a method the
   target phone accepts.
3. Upload the new package, preferably with an immutable versioned asset name.
4. Change `update.webmanifest` to the new `version`, `package_path`, and exact
   `packaged_size`; change its `b2g_features` to match the packaged manifest.
5. Change the app's `version`, `package_url` (if used), and `sha256` in
   `webapps.json`. Publish the package before the metadata so the advertised
   package URL is live when users refresh.

The Store's **Check update** action calls `AppsManager.checkForUpdate` with the
installed app's update URL, then `AppsManager.update` with its `manifestURL`.
Changing an installed app's update URL to a different host requires a migration
through its old URL; simply adding the same app to a new source can trigger a
duplicate-install error. Removing a source only removes its listing from the
Store. It does not uninstall its apps.

The packages prepared in this project pass the tested KaiOS package verifier,
but their CMS signatures are not cryptographically valid. Phone acceptance and
individual app compatibility require device testing.

## OStore handoff

The catalogue now lists OStore 1.2.6 in place of the older JScalated Store app.
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
