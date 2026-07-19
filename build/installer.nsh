!macro customUnInit
  ; Check if the uninstall policy file exists
  IfFileExists "$APPDATA\Remote Desk Agent\uninstall_policy.txt" +1 no_policy

  ; Read the properties from INI
  ReadINIStr $0 "$APPDATA\Remote Desk Agent\uninstall_policy.txt" "UninstallPolicy" "uninstallAllowed"
  ReadINIStr $1 "$APPDATA\Remote Desk Agent\uninstall_policy.txt" "UninstallPolicy" "email"
  ReadINIStr $2 "$APPDATA\Remote Desk Agent\uninstall_policy.txt" "UninstallPolicy" "uninstallKeyHash"
  ReadINIStr $3 "$APPDATA\Remote Desk Agent\uninstall_policy.txt" "UninstallPolicy" "apiUrl"

  ; If uninstallAllowed is false, display warning and abort
  StrCmp $0 "false" deny_uninstall

  ; Request uninstall key
  DetailPrint "Uninstall Allowed is true. Verification required."
  
  ; Run PowerShell script to prompt user and verify the key online or offline
  nsExec::ExecToStack 'powershell -NoProfile -WindowStyle Hidden -Command "& { \
    Add-Type -AssemblyName Microsoft.VisualBasic; \
    $key = [Microsoft.VisualBasic.Interaction]::InputBox(\"Please enter the Admin Uninstall Key to uninstall Remote Desk Agent:\", \"Uninstall Protection Required\", \"\"); \
    if (!$key) { exit 2; } \
    try { \
      $body = @{ email = \"$1\"; uninstallKey = \"$key\" } | ConvertTo-Json; \
      $response = Invoke-RestMethod -Uri \"$3/auth/verify-uninstall-key\" -Method Post -Body $body -ContentType \"application/json\" -TimeoutSec 5 -ErrorAction Stop; \
      if ($response.success -eq $true -or $response.success -eq \"true\") { exit 0 } else { exit 1 } \
    } catch { \
      $hashBytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key)); \
      $hashStr = [System.BitConverter]::ToString($hashBytes).Replace(\"-\", \"\").ToLower(); \
      if ($hashStr -eq \"$2\") { exit 0 } else { exit 1 } \
    } \
  }"'

  Pop $R0 ; Exit code of PowerShell command
  Pop $R1 ; Output (standard out) of PowerShell command

  ; Check exit code
  StrCmp $R0 "0" allow_uninstall
  StrCmp $R0 "2" cancel_uninstall

  MessageBox MB_OK|MB_ICONEXCLAMATION "Incorrect uninstall key. Uninstallation aborted."
  Abort

deny_uninstall:
  MessageBox MB_OK|MB_ICONSTOP "Uninstallation disabled by your administrator. Please contact your IT administrator to allow uninstallation."
  Abort

cancel_uninstall:
  Abort

no_policy:
  DetailPrint "No uninstall policy found. Proceeding with uninstallation."

allow_uninstall:
  ; Proceed with uninstall
!macroend
