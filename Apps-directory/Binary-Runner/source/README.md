# Binary Runner 1.0.8

Binary Runner offers the bundled ARMv7 and Nokia 2760 GhostLock binaries on
KaiOS 3. It keeps keypad navigation: Up/Down moves focus, Left/Right changes
the selected binary, the center key activates the focused control, the left
softkey returns to the binary choice, and the right softkey opens logs. The
binary chooser is a button so scrolling cannot open a native select popup.

## Stage a binary

1. Select a binary and choose **Stage binary**. The app checks the bundled
   binary's size, SHA-256, and ARM ELF header, then writes a one-time request
   for its separate installer XPI. It does not replace the JScalated ADB XPI.
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
stock updater on the Cingular Flex 2, copying ghostlock_armv7 into the
existing updater inode, preserving its system_data_file label, setting 0755,
and rebooting. That is live evidence for the ARMv7 binary on that phone. The
1.0.8 app's new automated sequence and the Nokia 2760 binary still need their
own handset checks.

Build with python package_app.py. python verify_package.py checks ZIP
integrity, nested XPI, manifests, and payload hashes. The available standalone
Python signer adds META-INF from an embedded reference and is a **signature
test fixture**: its CMS signature is copied, not recalculated with a private
key. It is not an authentic cryptographic signature; handset acceptance must
be checked separately.
