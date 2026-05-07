# blckbx remote access

blckbx remote access is a windows desktop app built with tauri + react +
webrtc that lets one machine host (share screen) and another machine
connect (view or control) using a single access code.

## quick start (host → viewer)

1.  host (share)
    -   open the app and go to share
    -   click start hosting
    -   approve the windows screen capture prompt when it appears
    -   copy the access code
2.  viewer (connect)
    -   open the app on the viewer machine and go to connect
    -   paste the access code
    -   click connect
    -   approve on the host when prompted (view-only or full control)
3.  remote control
    -   mouse dragging (hold + drag), right-click hold, keyboard input
    -   scroll wheel support
    -   optional fullscreen for a desktop-like experience

## how it works

-   signaling: websocket signaling connects host and viewer and handles
    consent and webrtc setup
-   media + input: webrtc sends the screen stream and encrypted input
    data
-   consent gating: the host must approve every viewer connection
-   overlays:
    -   small top-left cube shows hosting or connection state
    -   privacy blackout (if enabled) hides the host display on the
        viewer without affecting the viewer ui

## security model

-   per-session access password
    -   each app instance creates a short-lived session password
    -   password rotates automatically
-   secure signaling requirements
    -   public signaling must use wss://
    -   viewer rejects endpoints that:
        -   do not use the /signal route
        -   contain query parameters
        -   contain credentials (username/password)
-   webrtc encryption
    -   media and input channels use dtls-srtp encryption
-   input safety
    -   host permission required for remote control
    -   pointer movement and keyboard input are rate limited
    -   text input has a strict maximum length

## advanced network settings (optional)

network settings such as stun/turn servers and optional signaling url
are stored in localstorage under:

`blckbx.network.v1`

these settings mainly affect nat traversal. for internet connections,
make sure signaling is reachable and ice servers are configured
correctly.

## build instructions

### prerequisites

-   node.js compatible with the repo
-   rust toolchain (stable)
-   tauri prerequisites for windows

### install

``` bash
npm ci
```

### run (non release)

``` bash
npm run tauri dev
```

### build (release)

``` bash
npm run tauri build
```
<img width="1273" height="463" alt="image" src="https://github.com/user-attachments/assets/a024bb44-e28e-40b7-936b-6bed17409702" />

## troubleshooting

-   viewer "connected, but no stream"
    -   ask the host to restart hosting and share a new access code
    -   confirm the viewer can reach the signaling endpoint
-   no screen capture prompt on host
    -   click start hosting and wait for the windows permission prompt
-   input not working (drag/scroll/right-click)
    -   make sure the host granted full control
    -   if an os dialog takes focus, control may need to be approved
        again
