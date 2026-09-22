#!/usr/bin/env bash
#
# Record docs/demo.gif -- the screencast in the README.
#
# The editor really runs, the flake is really built and the devShell window is
# really opened; nothing here is staged. What is unusual is where it happens: a
# nested X server (Xvfb) rather than your desktop. That buys three things.
# The window geometry is fixed, so the frame is the same every time. Synthetic
# input works, which it does not on a Wayland session. And recording it does not
# take over the machine you are sitting at.
#
#   ./docs/record-demo.sh              # build a .vsix, record, write docs/demo.gif
#   VSIX=path/to.vsix ./docs/record-demo.sh
#   KEEP=1 ./docs/record-demo.sh       # leave the editor and Xvfb running
#
# Everything it needs beyond `nix` and an installed VS Code is fetched with
# `nix build`; the demo project is written from scratch under $WORK.
#
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=${WORK:-$HOME/.cache/nix-devshell-demo}
OUT=${OUT:-$REPO/docs/demo.gif}
XDISPLAY=${XDISPLAY:-:99}
WIDTH=${WIDTH:-1200}
HEIGHT=${HEIGHT:-760}
FPS=${FPS:-10}
GIF_WIDTH=${GIF_WIDTH:-1000}
# The `nix develop` wait is dead time for a viewer; the GIF plays it faster.
BUILD_SPEEDUP=${BUILD_SPEEDUP:-4}
# Pinned so the demo project's toolchain does not drift with nixpkgs.
NIXPKGS=${NIXPKGS:-github:NixOS/nixpkgs/ef34387ddd751e1ab8857adf4676492d32eb24ec}
KEEP=${KEEP:-0}

PROJECT=$WORK/hello-rust
UDD=$WORK/udd          # a scratch user-data-dir, so your own profile is untouched
EXTDIR=$WORK/ext       # ...and a scratch extensions dir holding only this extension
MARKS=$WORK/marks
VIDEO=$WORK/take.mkv

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --------------------------------------------------------------------- tools

# VS Code itself has to be the one you have installed: the extension needs
# `--enable-proposed-api`, which only a real editor can grant. A `code` on the
# PATH inside a devShell terminal is the *server's* CLI and would just hand the
# folder to the window you are sitting in, so prefer an explicit CODE=.
CODE=${CODE:-$(command -v code || true)}
case "$CODE" in
  */globalStorage/*|"")
    echo "Set CODE= to your VS Code launcher (the desktop one, not a remote-cli shim)." >&2
    exit 1
    ;;
esac

say "fetching the recording tools"
# ffmpeg needs x11grab, which the plain nixpkgs build does not carry.
nixbuild() { nix build --extra-experimental-features 'nix-command flakes' \
  --no-link --print-out-paths "$1"; }
FFMPEG=$(nixbuild "nixpkgs#ffmpeg-full" | grep -m1 -- -bin)/bin/ffmpeg
XDOTOOL=$(nixbuild "nixpkgs#xdotool" | head -1)/bin/xdotool
GIFSICLE=$(nixbuild "nixpkgs#gifsicle" | head -1)/bin/gifsicle
XVFB=${XVFB:-$(command -v Xvfb || true)}
[ -n "$XVFB" ] || XVFB=$(nixbuild "nixpkgs#xorg.xorgserver" | head -1)/bin/Xvfb

# ------------------------------------------------------------- demo project

say "writing the demo project into $PROJECT"
mkdir -p "$PROJECT/src"

cat > "$PROJECT/flake.nix" <<EOF
{
  description = "A tiny Rust project that brings its own editor setup";

  inputs.nixpkgs.url = "$NIXPKGS";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.\${system};
    in
    {
      devShells.\${system} = {
        default = pkgs.mkShell {
          name = "hello-rust";

          packages = with pkgs; [
            bashInteractive
            rustc
            cargo
            clippy
            rustfmt
            rust-analyzer
            nil
          ];

          RUST_SRC_PATH = "\${pkgs.rustPlatform.rustLibSrc}";

          # The editor tooling this shell wants, declared next to the toolchain.
          # A Marketplace id and a Nix package mix freely in one list.
          vscodeExtensions = [
            "rust-lang.rust-analyzer"
            pkgs.vscode-extensions.jnoortheen.nix-ide
            pkgs.vscode-extensions.tamasfe.even-better-toml
          ];

          # ...and the settings that point the editor at *these* binaries, by
          # store path, rather than at whatever the host happens to have.
          vscodeSettings = builtins.toJSON {
            "rust-analyzer.server.path" = "\${pkgs.rust-analyzer}/bin/rust-analyzer";
            "rust-analyzer.check.command" = "clippy";
            "rust-analyzer.rustfmt.overrideCommand" = [ "\${pkgs.rustfmt}/bin/rustfmt" ];
            "nix.enableLanguageServer" = true;
            "nix.serverPath" = "\${pkgs.nil}/bin/nil";
            "editor.formatOnSave" = true;
          };
        };

        # A second shell, so the picker has something to pick: the toolchain CI
        # needs, and nothing meant for an editor.
        ci = pkgs.mkShell {
          name = "hello-rust-ci";
          packages = with pkgs; [
            cargo
            clippy
          ];
        };
      };
    };
}
EOF

cat > "$PROJECT/Cargo.toml" <<'EOF'
[package]
name = "hello"
version = "0.1.0"
edition = "2021"

[dependencies]
EOF

cat > "$PROJECT/src/main.rs" <<'EOF'
fn main() {
    let greeting = greet("devShell");
    println!("{greeting}");
}

fn greet(name: &str) -> String {
    format!("Hello from the {name}!")
}
EOF

printf '/target\n' > "$PROJECT/.gitignore"
rm -rf "$PROJECT/.vscode"
(cd "$PROJECT" && nix flake lock >/dev/null 2>&1 || true)

# Build the shell and the binary now, so the recording shows the flow rather
# than a cold Nix store and a first `cargo build`.
say "warming the devShell (this is the slow part, and it is off camera)"
(cd "$PROJECT" && nix develop --extra-experimental-features 'nix-command flakes' \
  --command bash -c 'cargo build' >/dev/null)

# ------------------------------------------------------------ scratch profile

if [ -z "${VSIX:-}" ]; then
  say "packaging the extension"
  (cd "$REPO" && npm run --silent package >/dev/null)
  VSIX=$(ls -t "$REPO"/*.vsix | head -1)
fi

say "installing $(basename "$VSIX") into a scratch profile"
mkdir -p "$UDD/User/globalStorage" "$EXTDIR"

# The scratch profile gets a clean, legible workbench: no welcome tab, no
# menu bar, no chat, no minimap. Workspace trust is off because the extension
# refuses to activate in an untrusted folder and there is no one here to click.
cat > "$UDD/User/settings.json" <<'EOF'
{
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Dark Modern",
  "security.workspace.trust.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "update.showReleaseNotes": false,
  "window.menuBarVisibility": "hidden",
  "window.commandCenter": false,
  "chat.commandCenter.enabled": false,
  "chat.disableAIFeatures": true,
  "workbench.layoutControl.enabled": false,
  "workbench.tips.enabled": false,
  "workbench.editor.enablePreview": false,
  "breadcrumbs.enabled": false,
  "editor.minimap.enabled": false,
  "editor.stickyScroll.enabled": false,
  "editor.fontSize": 14,
  "terminal.integrated.fontSize": 13,
  "extensions.autoCheckUpdates": false,
  "extensions.ignoreRecommendations": true,
  "explorer.compactFolders": false,
  "files.hotExit": "off"
}
EOF

# Reuse the server this extension has already downloaded for your own profile,
# if there is one: it is ~1GB and identical.
for d in "$HOME/.config/Code/User/globalStorage/wiomoc.nix-devshell" \
         "$HOME/.config/VSCodium/User/globalStorage/wiomoc.nix-devshell"; do
  if [ -d "$d/server" ]; then
    mkdir -p "$UDD/User/globalStorage/wiomoc.nix-devshell"
    ln -sfn "$d/server" "$UDD/User/globalStorage/wiomoc.nix-devshell/server"
    break
  fi
done

# The editor is launched with the VSCODE_* variables of the terminal it is
# started from stripped: inside a devShell window they would route the CLI back
# to that window instead of starting an instance of our own. GDK_BACKEND and
# the Wayland socket go too, or Electron ignores DISPLAY and lands on the
# desktop you are sitting at.
launch_code() {
  ( unset $(env | grep -oE '^VSCODE_[A-Z_]+' | tr '\n' ' ') WAYLAND_DISPLAY NIXOS_OZONE_WL GDK_BACKEND
    export DISPLAY=$XDISPLAY XDG_SESSION_TYPE=x11 GDK_BACKEND=x11
    exec "$CODE" --ozone-platform=x11 --disable-gpu \
      --extensions-dir "$EXTDIR" --user-data-dir "$UDD" "$@"
  )
}

launch_code --install-extension "$VSIX" --force >/dev/null

# The window that opens first is an ordinary local one, and the file it opens
# on is a flake: without a Nix grammar the opening frame is a wall of grey.
# The devShell brings its own copy of this extension a few seconds later --
# this one is only so there is something to read before it does.
say "installing jnoortheen.nix-ide into the scratch profile"
launch_code --install-extension jnoortheen.nix-ide --force >/dev/null

# ------------------------------------------------------------- nested server

pids=()
cleanup() {
  [ "$KEEP" = 1 ] && return 0
  for pid in "${pids[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

# Mean brightness of a region of the nested display. The workbench has no
# accessibility surface to query from outside, so "is the quick pick up yet?"
# is answered by looking: that strip goes from ~24 (tab bar) to ~93 (the quick
# pick's title bar) the moment the picker opens.
probe() {
  "$FFMPEG" -v error -f x11grab -video_size "$3x$4" -i "$XDISPLAY+$1,$2" -vframes 1 \
    -f rawvideo -pix_fmt gray - 2>/dev/null |
    od -An -tu1 -v | awk '{for(i=1;i<=NF;i++){s+=$i;n++}} END{if(n)printf "%.0f\n",s/n; else print 0}'
}
probe_workbench() { probe 40 $((HEIGHT - 18)) 90 14; }   # the status bar strip
probe_quickpick() { probe $((WIDTH / 2 - 40)) 40 80 10; }  # the quick pick's title

say "clearing anything left over from an earlier run"
for pat in "Xvfb $XDISPLAY" "user-data-dir $UDD"; do
  for pid in $(pgrep -f "$pat" || true); do kill "$pid" 2>/dev/null || true; done
done
sleep 2

say "starting Xvfb on $XDISPLAY"
"$XVFB" "$XDISPLAY" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp &
pids+=($!)
sleep 2
export DISPLAY=$XDISPLAY

open_window() {
  rm -rf "$UDD/User/workspaceStorage" "$UDD/Backups"
  launch_code --new-window "$PROJECT" --goto "$PROJECT/flake.nix:39" >/dev/null 2>&1 &
  pids+=($!)
  # Wait for the workbench, then pin the window down: there is no window
  # manager on this display, so xdotool does the placing itself.
  for _ in $(seq 1 60); do
    wid=$("$XDOTOOL" search --name "Visual Studio Code" 2>/dev/null | head -1) && [ -n "$wid" ] && break
    sleep 1
  done
  # There is no window manager here, so the placing is ours to do -- and it has
  # to be in force before the first click, or the status bar is not where the
  # script thinks it is.
  for _ in $(seq 1 10); do
    "$XDOTOOL" windowmove "$wid" 0 0
    "$XDOTOOL" windowsize "$wid" "$WIDTH" "$HEIGHT"
    sleep 1
    geo=$("$XDOTOOL" getwindowgeometry "$wid" | awk '/Geometry/{print $2}')
    [ "$geo" = "${WIDTH}x${HEIGHT}" ] && break
  done
  # ...and the workbench has to be painted, extension included: a click into a
  # status bar that has not drawn its item yet goes nowhere, and the Return
  # meant for the picker lands in the editor.
  for _ in $(seq 1 60); do
    [ "$(probe_workbench)" -gt 20 ] && break
    sleep 1
  done
  sleep 3
}

close_window() {
  for pid in $(pgrep -f "user-data-dir $UDD" || true); do kill "$pid" 2>/dev/null || true; done
  sleep 3
}

# ------------------------------------------------------------------- driving

focus() {
  wid=$("$XDOTOOL" search --name "Visual Studio Code" | head -1)
  "$XDOTOOL" windowfocus "$wid"
}

# Glide rather than teleport, so a click on the status bar reads as a click.
glide() {
  local tx=$1 ty=$2 n=16 i
  eval "$("$XDOTOOL" getmouselocation --shell)"
  for i in $(seq 1 $n); do
    "$XDOTOOL" mousemove $(( X + (tx - X) * i / n )) $(( Y + (ty - Y) * i / n ))
    sleep 0.03
  done
}

mark() { echo "$(date +%s.%N) $1" >> "$MARKS"; }

wait_for_devshell_window() {
  for _ in $(seq 1 180); do
    "$XDOTOOL" search --name "hello-rust \[devShell" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "the devShell window never appeared" >&2
  return 1
}

# The take. Each beat is one thing the extension does, held long enough to read
# and not a breath longer: the pauses are paced like someone who knows the
# keystrokes, not like someone demonstrating them.
drive() {
  focus; "$XDOTOOL" mousemove 620 300; sleep 1.2

  # 1. the status bar says no devShell is active; clicking it offers one.
  #    Listing the devShells means evaluating the flake, so how long the picker
  #    takes to appear is not ours to predict -- wait for it, and click again if
  #    the first one was swallowed.
  glide 84 $((HEIGHT - 11)); sleep 0.4
  for attempt in 1 2 3; do
    "$XDOTOOL" click 1
    for _ in $(seq 1 20); do
      [ "$(probe_quickpick)" -gt 60 ] && break 2
      sleep 1
    done
    [ "$attempt" = 3 ] && { echo "the devShell picker never opened" >&2; return 1; }
  done
  sleep 1

  # 2. take `default`, the shell that declares its own editor tooling
  mark reopen
  "$XDOTOOL" key Return; sleep 0.5
  "$XDOTOOL" mousemove 950 250

  # 3. the window comes back with its server running inside `nix develop`
  wait_for_devshell_window
  sleep 6; focus; sleep 0.8
  mark connected

  # 4. the code, with the language server the flake asked for: inlay hints,
  #    code lenses and `rust-analyzer` in the status bar
  "$XDOTOOL" key ctrl+p; sleep 0.5; "$XDOTOOL" type --delay 45 "main.rs"; sleep 0.6
  "$XDOTOOL" key Return; sleep 3.5

  # 5. the toolchain itself, in a terminal that is a child of that server --
  #    and then out of the way again, so the settings get the whole window
  "$XDOTOOL" key ctrl+shift+grave; sleep 2
  "$XDOTOOL" type --delay 45 "cargo run"; sleep 0.4; "$XDOTOOL" key Return; sleep 3
  "$XDOTOOL" key ctrl+grave; sleep 0.8

  # 6. the settings the flake declared, as this window resolved them
  "$XDOTOOL" key ctrl+shift+p; sleep 0.6
  "$XDOTOOL" type --delay 40 "Open Remote Settings (JSON)"; sleep 1.2
  "$XDOTOOL" key Return; sleep 3.5
  "$XDOTOOL" key ctrl+w; sleep 0.8

  # 7. and the extension set this devShell brought with it -- scrolled so the
  #    whole "DEVSHELL - INSTALLED" group is on screen, not just its first two
  "$XDOTOOL" key ctrl+shift+x; sleep 2.5
  glide 150 400; sleep 0.4
  for _ in 1 2 3 4 5; do "$XDOTOOL" click 5; sleep 0.2; done
  sleep 3
}

# A dress rehearsal first: it downloads the Marketplace extension into the
# devShell's extensions directory and lets rust-analyzer index once, neither of
# which belongs in the recording.
say "rehearsing (warms the devShell window, nothing is recorded)"
open_window
drive >/dev/null 2>&1 || true
close_window

say "recording"
rm -f "$MARKS"
open_window
"$FFMPEG" -v error -y -f x11grab -framerate 24 -video_size "${WIDTH}x${HEIGHT}" \
  -draw_mouse 1 -i "$XDISPLAY" -c:v libx264 -preset ultrafast -crf 16 -pix_fmt yuv444p "$VIDEO" &
ffmpeg_pid=$!
pids+=("$ffmpeg_pid")
sleep 1
mark start
drive
sleep 1
kill -INT "$ffmpeg_pid" 2>/dev/null || true
wait "$ffmpeg_pid" 2>/dev/null || true
close_window

# ----------------------------------------------------------------- the GIF

say "building $OUT"
t_start=$(awk '/start$/{print $1}' "$MARKS")
t_reopen=$(awk '/reopen$/{print $1}' "$MARKS")
t_connected=$(awk '/connected$/{print $1}' "$MARKS")
# Offsets into the recording: hold the pick, run the build wait fast, then
# play the devShell window at speed again.
a=$(awk -v s="$t_start" -v r="$t_reopen" 'BEGIN{printf "%.2f", r - s + 2}')
b=$(awk -v s="$t_start" -v c="$t_connected" 'BEGIN{printf "%.2f", c - s}')

filter="[0:v]trim=0:$a,setpts=PTS-STARTPTS[a];\
[0:v]trim=$a:$b,setpts=(PTS-STARTPTS)/$BUILD_SPEEDUP[b];\
[0:v]trim=$b,setpts=PTS-STARTPTS[c];\
[a][b][c]concat=n=3:v=1[s];\
[s]fps=$FPS,scale=$GIF_WIDTH:-1:flags=lanczos,split[x][y];\
[x]palettegen=max_colors=128:stats_mode=diff[p];\
[y][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle"

"$FFMPEG" -v error -y -i "$VIDEO" -filter_complex "$filter" -loop 0 "$WORK/demo.gif"
"$GIFSICLE" -O3 --lossy=40 --colors 128 "$WORK/demo.gif" -o "$OUT" 2>/dev/null \
  || cp "$WORK/demo.gif" "$OUT"

say "$OUT -- $(du -h "$OUT" | cut -f1)"
