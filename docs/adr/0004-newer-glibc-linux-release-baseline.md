# Newer glibc Linux release baseline

Superseded on 2026-09-15: the Owner chose the official musl release target instead, accepting a target-specific rebuild to simplify distribution and avoid maintaining bundled glibc-linked dependencies. The former newer-glibc restriction is no longer the intended public release contract; supported systems remain subject to artifact verification.

The first Linux x64 release targets newer glibc distributions, including Ubuntu 24.04 and Debian 13, rather than older distributions or musl. The existing locally built app-server references GLIBC 2.39; retaining that baseline avoids another target/toolchain transition and its rebuild cost. Released artifacts must use a distribution loader and relocatable bundled non-system libraries, with no dependency on the maintainer's Nix store. Clean-environment verification is required before claiming installability. macOS ARM64 remains a separate supported platform; older Linux and musl are deferred.
