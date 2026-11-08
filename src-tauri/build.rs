fn main() {
    println!("cargo:rustc-env=FOOD_TARGET={}", std::env::var("TARGET").unwrap());
    tauri_build::build()
}
