!macro currentUserOnly
  ${If} ${isForAllUsers}
    MessageBox MB_ICONSTOP "Wireframe Studio supports current-user installation only."
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro setInstallModePerUser
!macroend

!macro customInit
  !insertmacro currentUserOnly
!macroend

!macro customUnInit
  !insertmacro currentUserOnly
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
