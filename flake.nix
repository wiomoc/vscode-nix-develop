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
          devShells =
            let
              NIX_DEVELOP_APP_ROOT =
                if pkgs.stdenv.hostPlatform.isDarwin then
                  "${pkgs.vscodium}/Applications/VSCodium.app/Contents/Resources/app"
                else
                  "${pkgs.vscodium}/lib/vscode/resources/app";
            in
            {
              default = pkgs.mkShell {
                name = "nix-develop-extension";
                packages = with pkgs; [
                  bashInteractive
                  nodejs_22
                  typescript-language-server
                ];
                EXTENSION_DEV = "1";

                shellHook = ''
                  echo "nix-develop extension dev shell -- npm install && npm run build"
                '';
              };

              # What CI runs in, and a small shell for exercising the picker.
              #
              # The editor is here for `test/pty.test.ts`: this extension borrows the
              # editor's `node-pty` rather than depending on one, and that test only
              # exercises the borrowing when `NIX_DEVELOP_APP_ROOT` points it at an
              # installed editor's `resources/app`. Without it the test skips.
              #
              # VSCodium rather than VS Code, for two reasons. It is free, so nothing
              # here needs `allowUnfree`. And VS Code moved `node_modules` into
              # `node_modules.asar` in 1.129 -- `node-pty`'s `lib/index.js` lives inside
              # the archive, readable only through Electron's asar-aware `fs` -- while
              # VSCodium is still on 1.126, which lays it out as plain files. The tests
              # run under plain node, so only the latter is loadable.
              ci = pkgs.mkShell {
                name = "nix-develop-ci";
                packages = [
                  pkgs.nodejs_22
                  pkgs.vscodium
                ];

                inherit NIX_DEVELOP_APP_ROOT;
              };

              # --------------------------------------------------------------------
              # Declaring the editor's extensions in the flake
              # --------------------------------------------------------------------
              #
              # A `vscodeExtensions` list says which VS Code extensions belong to this
              # devShell. It is picked up when the folder is reopened with
              # "Nix Develop: Reopen in devShell", and it is scoped to this devShell alone.
              #
              # Entries come in two forms, and may be mixed freely:
              #
              # 1. A Nix package -- from `pkgs.vscode-extensions` (nixpkgs' own curated set)
              #    or from nix-vscode-extensions (almost every Marketplace / Open VSX
              #    extension). These are built and pinned by the flake lock, so everyone gets
              #    the same version and nothing is downloaded from the Marketplace at
              #    activation. mkShell stringifies a derivation to its store path, and the
              #    package installs to $out/share/vscode/extensions/<publisher>.<name>, which
              #    is all the extension needs to find it.
              #
              # 2. A Marketplace ID string. Unpinned and fetched on first use, but it needs
              #    no extra flake input and no build.
              #
              # Prefer (1) when you want reproducibility, (2) when you want brevity.
              #
              # `vscodeExtensions` is the only place this is read from: an extension package
              # in `packages` is on the shell's PATH like any other tool, and nothing else.
              editor = pkgs.mkShell {
                name = "nix-develop-editor";

                packages = with pkgs; [
                  bashInteractive
                  nodejs_22
                  typescript-language-server
                ];

                inherit NIX_DEVELOP_APP_ROOT;

                vscodeExtensions = [
                  # (1) built by Nix, pinned by flake.lock
                  marketplace.jnoortheen.nix-ide # from nix-vscode-extensions
                  marketplace.vitest.explorer # the test suite's runner, in the test explorer
                  pkgs.vscode-extensions.bierner.markdown-mermaid
                  # (2) resolved from the Marketplace on first use
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
