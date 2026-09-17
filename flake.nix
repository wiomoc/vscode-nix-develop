{
  description = "Nix Develop -- a VS Code extension that applies a flake devShell to the editor";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # Nix expressions for (almost) every VS Code Marketplace / Open VSX extension.
    # Used by the `editor` devShell below to demonstrate pinning editor tooling in a flake.
    nix-vscode-extensions = {
      url = "github:nix-community/nix-vscode-extensions";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      nix-vscode-extensions,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        marketplace = nix-vscode-extensions.extensions.${system}.vscode-marketplace;
      in
      {
        devShells = {
          default = pkgs.mkShell {
            name = "nix-develop-extension";
            packages = with pkgs; [
              bashInteractive
              nodejs_22
              typescript-language-server
              vsce
            ];
            EXTENSION_DEV = "1";

            # `nix develop` points SHELL at nixpkgs' bash-minimal, which is built without
            # readline: no history, no line editing, no completion, and prompt markers
            # printed literally. A plain `SHELL = ...` attribute does not survive -- the
            # dev-env script sets SHELL from stdenv before the hook runs -- so export it
            # here, where it wins.
            shellHook = ''
              export SHELL=${pkgs.bashInteractive}/bin/bash
              echo "nix-develop extension dev shell -- npm install && npm run build"
            '';
          };

          # A deliberately minimal shell, handy for exercising the picker.
          ci = pkgs.mkShell {
            name = "nix-develop-ci";
            packages = [ pkgs.nodejs_22 ];
          };

          # --------------------------------------------------------------------
          # Declaring the editor's extensions in the flake
          # --------------------------------------------------------------------
          #
          # Two ways to say which VS Code extensions belong to a devShell. Both are
          # picked up when the folder is reopened with "Nix Develop: Reopen in devShell",
          # and both are scoped to this devShell.
          #
          # 1. As Nix packages, via nix-vscode-extensions (or pkgs.vscode-extensions).
          #    These are built and pinned by the flake lock, so everyone gets the same
          #    version and nothing is downloaded from the Marketplace at activation.
          #    A package installs to $out/share/vscode/extensions/<publisher>.<name>,
          #    and putting it in `packages` puts $out/share on XDG_DATA_DIRS, which is
          #    how the extension finds it. Nothing else is required.
          #
          # 2. As Marketplace IDs in a `vscodeExtensions` list. mkShell turns a Nix list
          #    into a space-separated environment variable, so the extension reads it
          #    straight out of the shell and installs anything missing. Unpinned, but it
          #    needs no extra flake input.
          #
          # Prefer (1) when you want reproducibility, (2) when you want brevity.
          editor = pkgs.mkShell {
            name = "nix-develop-editor";

            packages = [
              pkgs.bashInteractive
              pkgs.nodejs_22

              # (1) pinned by flake.lock, built by Nix
              marketplace.jnoortheen.nix-ide
              marketplace.tamasfe.even-better-toml

              # The language server nix-ide is pointed at by `vscodeSettings` below.
              pkgs.nil
              pkgs.nixfmt
            ];

            # (2) resolved from the Marketplace on first use
            vscodeExtensions = [
              "esbenp.prettier-vscode"
            ];

            # Settings for the devShell's window, in the same spirit: the shell knows
            # where its own tools are, so it can point the editor at them instead of
            # every checkout carrying a machine-specific path. Derivation attributes are
            # strings, so an attrset is spelled as JSON; these land in the server's
            # machine settings, which is per devShell and never touches the workspace.
            vscodeSettings = builtins.toJSON {
              "nix.enableLanguageServer" = true;
              "nix.serverPath" = "${pkgs.nil}/bin/nil";
              "nix.formatterPath" = "${pkgs.nixfmt}/bin/nixfmt";
              "workbench.externalBrowser" = "${pkgs.chromium}/bin/chromium";
            };

            shellHook = ''
              export SHELL=${pkgs.bashInteractive}/bin/bash
            '';
          };
        };
      }
    );
}
