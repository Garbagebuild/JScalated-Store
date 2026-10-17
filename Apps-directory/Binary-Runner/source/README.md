# Binary Runner 1.0.3

The app bundles two ARMv7 binaries and a separate profile XPI. The XPI keeps
the binary replacement request one-shot and starts a loopback debug command
socket on port 5556 at B2G startup. It does not restart B2G, reboot the phone,
or run a bundled binary when the socket starts.

To install or refresh the XPI from the app, select **Install debug XPI** and
restart the phone manually. **Refresh XPI logs** shows the listener state and
the token. Connect to `127.0.0.1:5556`, send `AUTH <token>`, then `STATUS` or
`RUN <command>`. Commands run under B2G's permissions, with an eight-second
limit and up to 8192 bytes of output. If B2G is forbidden from launching
`/system/bin/sh`, the socket reports the launch error. It is not a root shell.

Build with `python tools/package_app.py`. Run the filesystem and socket mock
checks with `node tools/mock_xpi_test.js`. These checks do not prove that the
phone loads the XPI, permits the socket, or allows B2G to start the shell.

The release ZIP contains META-INF fixture records made by the existing Python
research signer. That script says its CMS signature is cryptographically
invalid. Device installation must be tested separately; the ZIP must not be
described as genuinely signed.
