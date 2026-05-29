use dashmap::DashMap;
use serde::Serialize;
use specta::Type;
use tauri_specta::Event;

use crate::error::Error;

#[derive(Clone, Debug, Serialize, Type)]
pub struct ProgressItem {
    pub id: String,
    pub progress: f32,
    pub finished: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Type, Event)]
pub struct ProgressEvent {
    pub id: String,
    pub progress: f32,
    pub finished: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub message: Option<String>,
}

pub type ProgressStore = DashMap<String, ProgressItem>;

pub fn update_progress(
    store: &ProgressStore,
    app: &tauri::AppHandle,
    id: String,
    progress: f32,
    finished: bool,
    message: Option<String>,
) -> Result<(), Error> {
    let item = ProgressItem {
        id: id.clone(),
        progress,
        finished,
        message: message.clone(),
    };

    store.insert(id.clone(), item.clone());

    ProgressEvent {
        id: item.id,
        progress: item.progress,
        finished: item.finished,
        message,
    }
    .emit(app)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_progress(id: String, state: tauri::State<'_, crate::AppState>) -> Option<ProgressItem> {
    state.progress_state.get(&id).map(|v| v.clone())
}

#[tauri::command]
#[specta::specta]
pub fn clear_progress(id: String, state: tauri::State<'_, crate::AppState>) {
    state.progress_state.remove(&id);
}
