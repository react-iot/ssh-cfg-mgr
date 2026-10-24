// Do not open a console window next to the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ssh_cfg_mgr::run();
}
