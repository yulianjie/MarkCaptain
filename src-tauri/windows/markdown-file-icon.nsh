; Tauri's built-in NSIS association uses the application executable icon.
; Replace it with the bundled Markdown document icon after associations exist.
; Windows can also store a default-app choice as Applications\<exe>, so keep
; that ProgID complete and pointed at this installation as well.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHELL_CONTEXT "Software\Classes\MarkCaptain.Markdown\DefaultIcon" "" "$\"$INSTDIR\icons\md.ico$\",0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon" "" "$\"$INSTDIR\icons\md.ico$\",0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".md" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".markdown" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".mkd" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".mdown" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".mkdn" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".mdtxt" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".mdtext" ""
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  !insertmacro UPDATEFILEASSOC
!macroend
