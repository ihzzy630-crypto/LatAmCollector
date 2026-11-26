#ifndef AppVersion
  #define AppVersion "0.6.1"
#endif

[Setup]
AppId={{14E201DE-F964-49EF-9FB8-C577FEC647F0}
AppName=LatAmCollector
AppVersion={#AppVersion}
AppPublisher=LatAmCollector
AppPublisherURL=https://github.com/ihzzy630-crypto/LatAmCollector
DefaultDirName={code:DefaultInstallDir}
DefaultGroupName=LatAmCollector
DisableProgramGroupPage=yes
DisableDirPage=no
UsePreviousAppDir=yes
PrivilegesRequired=lowest
MinVersion=10.0
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\LatAmCollector.exe
SourceDir=..
OutputDir=dist
OutputBaseFilename=LatAmCollector-Setup-{#AppVersion}-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Tasks]
Name: "autostart"; Description: "Start the local service when I sign in to Windows"; Flags: unchecked

[Files]
Source: "dist\LatAmCollector.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "chrome_extension\*"; DestDir: "{app}\chrome_extension"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "windows\Windows-Guide.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userdesktop}\LatAmCollector"; Filename: "{app}\LatAmCollector.exe"; WorkingDir: "{app}"
Name: "{group}\LatAmCollector"; Filename: "{app}\LatAmCollector.exe"; WorkingDir: "{app}"
Name: "{group}\Chrome Helper Folder"; Filename: "{win}\explorer.exe"; Parameters: """{app}\chrome_extension"""
Name: "{group}\Windows Guide"; Filename: "{app}\Windows-Guide.txt"
Name: "{userstartup}\LatAmCollector-AutoStart"; Filename: "{app}\LatAmCollector.exe"; Parameters: "--no-browser"; WorkingDir: "{app}"; Tasks: autostart

[Run]
Filename: "{app}\LatAmCollector.exe"; WorkingDir: "{app}"; Description: "Open LatAmCollector"; Flags: nowait postinstall skipifsilent
Filename: "{app}\Windows-Guide.txt"; Description: "Read the Chrome helper setup guide"; Flags: shellexec nowait postinstall unchecked skipifsilent

[Code]
function DefaultInstallDir(Param: String): String;
var
  LegacyDir: String;
begin
  LegacyDir := 'D:\gpt' + #$4E13 + #$7528 + #$6587 + #$4EF6 + '\LatAmCollector';
  if FileExists(LegacyDir + '\data\latam_collector.db') or
     FileExists(LegacyDir + '\launcher.py') or FileExists(LegacyDir + '\LatAmCollector.exe') then
    Result := LegacyDir
  else
    Result := ExpandConstant('{localappdata}\Programs\LatAmCollector');
end;
