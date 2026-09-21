{
  description = "Nix Develop - apply flake devShells to vscode";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

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
      nix-vscode-extensions,
      ...
    }:
    let
      publisher = "wiomoc";
      pname = "nix-develop";
      vscodeExtUniqueId = "${publisher}.${pname}";
      forAllSystems =
        let
          systems = [
            "x86_64-linux"
            "aarch64-linux"
            "aarch64-darwin"
          ];
          attrNames = [
            "devShells"
            "overlays"
            "packages"
          ];
        in
        inner:
        builtins.listToAttrs (
          nixpkgs.lib.map (attrName: {
            name = attrName;
            value = builtins.listToAttrs (
              nixpkgs.lib.map (system: {
                name = system;
                value = (inner system).${attrName};
              }) (builtins.filter (system: builtins.hasAttr attrName (inner system)) systems)
            );
          }) attrNames
        );
    in
    (
      (forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          marketplace = nix-vscode-extensions.extensions.${system}.vscode-marketplace;
        in
        {
          packages.default =
            let
              version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
              vsix = pkgs.buildNpmPackage {
                inherit pname version;
                name = "${pname}-${version}.vsix";
                src = ./.;
                buildInputs = [
                  pkgs.libsecret
                ];
                nativeBuildInputs = [
                  # Required by `keytar`, which is a dependency of `vsce`.
                  pkgs.pkg-config
                ];
                npmDepsHash = "sha256-00pkvk1pll5XxJUioBVt8eZjZmBPqwXPJFxsAuTKkF0=";
                installPhase = "
              runHook preInstall
              npm exec --package=@vscode/vsce -- vsce package --out $out
              runHook postInstall
              ";
              };
            in
            pkgs.vscode-utils.buildVscodeExtension {
              inherit version pname vscodeExtUniqueId;
              src = vsix;
              passthru.vsix = vsix;
              vscodeExtPublisher = publisher;
              vscodeExtName = pname;

              meta = {
                description = "Apply flake devShells to vscode";
                homepage = "https://github.com/wiomoc/vscode-nix-develop";
                license = [
                  pkgs.lib.licenses.mit
                ];
                maintainers = [ ];
                platforms = pkgs.lib.platforms.all;
              };
            };
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

              shellHook = ''
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
                pkgs.python314
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
                "workbench.externalBrowser" = "${pkgs.firefox}/bin/firefox";
              };
            };
          };
        }
      ))
      // (
        let
          commandLineArgs = "--enable-proposed-api ${vscodeExtUniqueId}";
        in
        {
          overlays.default = (
            final: prev:
            let
              vscode = prev.vscode.override {
                inherit commandLineArgs;
              };
            in
            {
              vscode = vscode;
              vscode-fhs = vscode;
            }
          );
          nixosModules.default = { pkgs, ... }: {
            config = {
              programs.vscode = {
                package = pkgs.vscode.override {
                  inherit commandLineArgs;
                };
                extensions = [
                  self.packages.${pkgs.stdenv.hostPlatform.system}.default
                ];
              };
            };
          };
        }
      )
    );
}
