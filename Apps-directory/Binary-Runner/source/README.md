# Binary Runner 1.0.9

Binary Runner offers the bundled Cingular Flex 2, Nokia 2760, and TCL Flip 3 GhostLock binaries on
KaiOS 3. Press **Select binary** to open the native bundled selector. The
selector is hidden while navigating the other controls; older Gecko builds
may need a second center-key press after it appears. Back closes the platform
popup; press Back again if the selector remains visible. Up/Down moves focus
through the page, the left softkey returns to **Select binary**, and the
right softkey opens logs.
**Load local binary** opens the device's file picker for a file in Downloads or
Files. Selection only reads the file; **Stage binary** performs staging.

## Stage a binary

1. Select a bundled binary or load a local file, then choose **Stage binary**.
   The app checks its size, SHA-256, and 32-bit ARM ELF header. Bundled entries
   must also match the packaged catalog. A local file is read again before
   staging and the installer independently checks its request, size, hash,
   and ELF header. The app then writes a one-time request
   for its separate installer XPI. It does not replace the JScalated ADB XPI.
   Local files are not matched to a specific phone or kernel; select one that
   was built for the device.
2. Reboot manually once. The installer stops the updater-daemon service using
   its service name, removes both the installed file and init marker, starts
   the stock wrapper, and verifies a fresh stock updater against the system copy.
3. The installer stops the service again, confirms the stock file is writable,
   copies the chosen binary **into that existing inode** with cp -f, sets mode
   0755, and checks SHA-256, inode, SELinux label, and stopped service state.
   If staging fails, it attempts to restore and start the stock updater.
4. Choose **Check status**. After a successful result, reboot manually again
   to start the chosen binary. Neither the app nor the XPI reboots the phone.

**Restore stock updater** saves a separate one-time XPI request. On the next
manual reboot, the XPI stops the updater, removes the installed file and init,
starts the stock wrapper, and verifies the restored file. This avoids deleting
the live updater from the app before the helper can control the service.

The debug XPI listens on loopback port 5556 and accepts local commands without
a token, as requested. Other local processes may be able to connect to that
socket. GhostLock's root shell, when the device-specific exploit succeeds, is
separate and listens on loopback port 5557.

Samuel reported a root prompt from port 5557 after manually restoring a fresh
stock updater on the Cingular Flex 2, copying the earlier ghostlock_armv7 into the
existing updater inode, preserving its system_data_file label, setting 0755,
and rebooting. The 1.0.9 Cingular_Flex_2 binary retains only its exact
`4.9.277-perf+-ab1735940312` offset row; all entry points reject older
kernels. This rebuilt binary and the automated staging sequence still need a
handset check.

The TCL_Flip_3 port uses offsets recovered from the supplied `tclboot.img`
(SHA-256 `3ce509844c950c479cbcecd68cfa802a045e91e6573a278241239a385bc70489`).
It requires a recognized TCL Flip 3 product model, exact `uname -r`
`4.9.277-perf+`, and the boot image's `/proc/version` build string before
running any mode. Its task and credential offsets and futex/select stack
layout were checked against the recovered ARM image. The existing updater
launch and api-daemon paths are retained. This is static compatibility
evidence; the TCL binary, Nokia binary, and their staging flows still need
tests on their respective phones. Other 4.9.277 builds require their own
offset and layout checks.

Build from this source directory with `python tools/package_app.py`. The
published 1.0.9 ZIP passed checks of its ZIP integrity, nested XPI, manifests,
and payload hashes. Picker and local-staging mock checks passed in the
development project. The available standalone Python signer adds META-INF
from an embedded reference and is a **signature
test fixture**: its CMS signature is copied, not recalculated with a private
key. It is not an authentic cryptographic signature; handset acceptance must
be checked separately.
