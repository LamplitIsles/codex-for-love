// Groups 01–15 follow rust-v0.153.4; 16 follows public Python SDK commit 1a4096e273e8.
export const officialExamples = [
  "01_quickstart_constructor", "02_turn_run", "03_turn_stream_events",
  "04_models_and_metadata", "05_existing_thread", "06_thread_lifecycle_and_controls",
  "07_image_and_text", "08_local_image_and_text", "09_async_parity",
  "10_error_handling_and_retry", "11_cli_mini_app", "12_turn_params_kitchen_sink",
  "13_model_select_and_turn_params", "14_turn_controls", "15_login_and_account",
  "16_external_message",
];

export const smokeExamples = ["stream", "approvals", "interrupt-resume", ...officialExamples];
