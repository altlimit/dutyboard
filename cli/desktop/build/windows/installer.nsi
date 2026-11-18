; DutyBoard for the desktop, as an installer: DutyBoard-Setup.exe.
;
; For one person, with no administrator: the app goes in their own Programs folder, gets a Start menu
; entry and an entry in Windows' list of installed apps, and is removed from both by its uninstaller.
; What the app keeps — its home, %LOCALAPPDATA%\DutyBoard — is not the installer's and is left alone,
; by installing over a copy and by uninstalling alike.
;
; It is built twice. A signed uninstaller has to exist before the installer that carries it does, and
; NSIS only writes an uninstaller by running an installer, so:
;
;   makensis -DUNINSTALLER_ONLY ...   makes make-uninstaller.exe; run it /S and it writes Uninstall.exe
;   (sign DutyBoard.exe and Uninstall.exe)
;   makensis ...                      makes DutyBoard-Setup.exe from the two signed files
;
;   -DVERSION=2.32.0   required
;   -DSRC=dir          where DutyBoard.exe and Uninstall.exe are, and where the outputs go
;
; Paths here are joined with a backslash, always. On Windows NSIS finds a file by splitting its path
; at the last backslash and looking in that folder, so "dir/DutyBoard.exe" is not found there; on
; Linux it turns backslashes into slashes itself. A forward slash compiles on Linux and only there.
;   -DPRODUCT=name     defaults to DutyBoard; a test passes another so it cannot touch a real install
;   -DRUN_NAME=name    the sign-in entry it looks after; a test passes another for the same reason

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !error "VERSION is required"
!endif
!ifndef SRC
  !error "SRC is required"
!endif
!ifndef PRODUCT
  !define PRODUCT "DutyBoard"
!endif

!define EXE "DutyBoard.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
; The name the app gives its own "start when I sign in" entry (autostartID in gui.go). It belongs to
; the person's real install, so anything trying this installer out must name another.
!ifndef RUN_NAME
  !define RUN_NAME "DutyBoard"
!endif

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
Name "${PRODUCT}"
BrandingText "${PRODUCT} ${VERSION}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT}"
SetCompressor /SOLID lzma

!ifdef UNINSTALLER_ONLY
  OutFile "${SRC}\make-uninstaller.exe"
  !insertmacro MUI_UNPAGE_CONFIRM
  !insertmacro MUI_UNPAGE_INSTFILES
!else
  OutFile "${SRC}\DutyBoard-Setup.exe"
  !insertmacro MUI_PAGE_INSTFILES
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Open DutyBoard"
  !define MUI_FINISHPAGE_RUN_FUNCTION OpenDutyBoard
  !define MUI_FINISHPAGE_NOREBOOTSUPPORT
  !insertmacro MUI_PAGE_FINISH
!endif
!insertmacro MUI_LANGUAGE "English"

; Asks a DutyBoard that is running from $INSTDIR to quit, and waits until its file can be replaced.
; The app stops its agents' sessions first, which it gives up to twenty seconds, so this waits longer.
!macro CloseRunningApp
  ${If} ${FileExists} "$INSTDIR\${EXE}"
    ExecWait '"$INSTDIR\${EXE}" --quit'
    StrCpy $1 0
    ${Do}
      ClearErrors
      FileOpen $0 "$INSTDIR\${EXE}" a
      ${IfNot} ${Errors}
        FileClose $0
        ${ExitDo}
      ${EndIf}
      Sleep 500
      IntOp $1 $1 + 1
    ${LoopUntil} $1 > 80
  ${EndIf}
!macroend

!ifndef UNINSTALLER_ONLY
Function OpenDutyBoard
  Exec '"$INSTDIR\${EXE}"'
FunctionEnd
!endif

Section "Install"
!ifdef UNINSTALLER_ONLY
  WriteUninstaller "$EXEDIR\Uninstall.exe"
!else
  SetShellVarContext current
  !insertmacro CloseRunningApp
  SetOutPath "$INSTDIR"
  ClearErrors
  File "/oname=${EXE}" "${SRC}\${EXE}"
  File "${SRC}\Uninstall.exe"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "DutyBoard could not be installed: its files could not be written. If DutyBoard is running, quit it from its tray icon and run this again." /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
  ; What an update leaves beside the app until the next one.
  Delete "$INSTDIR\${EXE}.old.*"

  CreateShortcut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Altlimit LLC"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" '"$INSTDIR\${EXE}",0'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "https://www.dutyboard.com"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  ; Someone who ran the app from their Downloads folder and ticked "start when I sign in" has an
  ; entry pointing there. It now starts the installed one.
  ReadRegStr $0 HKCU "${RUN_KEY}" "${RUN_NAME}"
  ${If} $0 != ""
    WriteRegStr HKCU "${RUN_KEY}" "${RUN_NAME}" '"$INSTDIR\${EXE}" --tray'
  ${EndIf}
!endif
SectionEnd

!ifdef UNINSTALLER_ONLY
Section "Uninstall"
  SetShellVarContext current
  !insertmacro CloseRunningApp

  ; Only an entry that starts THIS copy. One for a copy somewhere else is not ours to remove.
  ReadRegStr $0 HKCU "${RUN_KEY}" "${RUN_NAME}"
  ${If} $0 == '"$INSTDIR\${EXE}" --tray'
  ${OrIf} $0 == '$INSTDIR\${EXE} --tray'
    DeleteRegValue HKCU "${RUN_KEY}" "${RUN_NAME}"
  ${EndIf}

  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\${EXE}.old.*"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
!endif
