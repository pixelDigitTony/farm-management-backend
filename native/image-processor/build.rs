fn main() {
    let bundle_root = std::env::var("FARM_VIPS_BUNDLE_ROOT").ok();
    let vips = pkg_config::Config::new()
        .cargo_metadata(bundle_root.is_none())
        .atleast_version("8.12")
        .probe("vips-cpp")
        .expect("libvips development files required");
    let mut versions = Vec::new();
    let mut builder = cc::Build::new();
    if let Some(root) = bundle_root {
        let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            _ => panic!("Unsupported native bundle architecture"),
        };
        let package = format!("sharp-libvips-linux-{arch}");
        let directory = std::path::Path::new(&root).join(&package);
        let libraries = directory.join("lib");
        let library = std::fs::read_dir(&libraries)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("libvips-cpp.so.")
            })
            .expect("Pinned libvips bundle missing");
        let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
        let link = out.join("libvips-cpp.so");
        if std::fs::symlink_metadata(&link).is_ok() {
            std::fs::remove_file(&link).unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&library, &link).unwrap();
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-lib=dylib=vips-cpp");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", libraries.display());
        println!("cargo:rustc-link-arg=-Wl,-rpath,/app/node_modules/@img/{package}/lib");
        let manifest = directory.join("versions.json");
        versions.push(
            std::fs::read_to_string(&manifest)
                .unwrap()
                .replace(['\n', '\r'], ""),
        );
        println!("cargo:rerun-if-changed={}", manifest.display());
        builder.define("FARM_VIPS_BUNDLED", None);
    } else {
        for name in ["vips-cpp", "libheif", "libwebp", "libpng", "lcms2"] {
            let package = pkg_config::Config::new()
                .probe(name)
                .expect("Required native codec missing");
            versions.push(format!("{name}-{}", package.version));
        }
    }
    println!("cargo:rustc-env=FARM_NATIVE_BUILD={}", versions.join(";"));
    builder.cpp(true).std("c++17").file("src/vips.cpp");
    for path in vips.include_paths {
        builder.include(path);
    }
    builder.compile("farm_vips");
    println!("cargo:rerun-if-changed=src/vips.cpp");
    println!("cargo:rerun-if-env-changed=FARM_VIPS_BUNDLE_ROOT");
}
