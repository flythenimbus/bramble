; Uninstall cleanup for things Tauri's uninstaller cannot know about.
;
; It removes what the INSTALLER put down. Everything below was written later, by the running app:
; the registry values that tell each browser where the native-messaging manifest is, the autostart
; entry, the data directory, and the credentials in Windows Credential Manager. None of it is
; tracked by the installer, so without this an uninstall leaves all of it behind.
;
; Two tiers, and the split is the point.
;
; The browser and autostart values are removed ALWAYS and without asking. They are pointers to a
; binary that is being deleted, so keeping them helps nobody: a NativeMessagingHosts value naming
; a missing file makes the browser fail in a way that looks like the browser's fault, long after
; Bramble is gone.
;
; The vault and the credentials are only removed if the user asks, and the prompt defaults to NO.
; Plenty of uninstalls are really reinstalls, and a prompt that defaults to destroying an unsynced
; vault will eventually take someone's passwords with it. Better to leave data behind than to be
; the reason it is gone.
;
; See src/manifest.rs for the browser table this mirrors, and src/secure_store.rs for why the
; credentials are deleted by the app rather than from here.

Var BramblePurgeData

; Runs while the files still exist, which is what `--purge-secrets` needs: the credential names
; are only derivable by the app, so the binary has to still be there to do it.
!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $BramblePurgeData "0"
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Also remove your Bramble vault and saved credentials from this computer?$\r$\n$\r$\n\
     This deletes the local vault, your backup provider credentials, and this device's sync \
     identity. It cannot be undone.$\r$\n$\r$\n\
     Choose No to leave your data in place, for example if you are reinstalling." \
    /SD IDNO IDNO keep_data

    StrCpy $BramblePurgeData "1"
    ; The app deletes its own credentials: their names include vault and target ids that only it
    ; can enumerate. Windowless, and its exit code is ignored on purpose, since a credential that
    ; will not delete is not a reason to fail an uninstall.
    nsExec::Exec '"$INSTDIR\Bramble.exe" --purge-secrets'

  keep_data:
!macroend

; Runs after the installer's own files, keys and shortcuts are gone.
!macro NSIS_HOOK_POSTUNINSTALL
  ; Every browser src/manifest.rs can write to. Vivaldi is absent on purpose: it reads Chrome's
  ; key rather than its own, so Chrome's entry below is already its entry.
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\app.bramble.desktop"
  DeleteRegKey HKCU "Software\Google\Chrome Beta\NativeMessagingHosts\app.bramble.desktop"
  DeleteRegKey HKCU "Software\Google\Chrome Dev\NativeMessagingHosts\app.bramble.desktop"
  DeleteRegKey HKCU "Software\Google\Chrome SxS\NativeMessagingHosts\app.bramble.desktop"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\app.bramble.desktop"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\app.bramble.desktop"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser-Beta\NativeMessagingHosts\app.bramble.desktop"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\app.bramble.desktop"
  ; Left over from before Vivaldi was pointed at Chrome's key. Harmless but dead, and an uninstall
  ; is the right time to stop carrying it.
  DeleteRegKey HKCU "Software\Vivaldi\NativeMessagingHosts\app.bramble.desktop"

  ; tauri-plugin-autostart's entry, which otherwise tries to launch a deleted binary at every
  ; login. Named for the product, so it tracks productName in tauri.conf.json.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bramble"

  ${If} $BramblePurgeData == "1"
    ; Roaming holds the vault and the manifest; local holds the logs and the WebView2 profile.
    ; Two roots, which is exactly the sort of split that gets half-remembered and half-deleted.
    RMDir /r "$APPDATA\app.bramble.desktop"
    RMDir /r "$LOCALAPPDATA\app.bramble.desktop"
  ${EndIf}
!macroend
