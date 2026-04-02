#define MyAppName "TestAgent"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "TestAgent"
#define MyAppExeName "testagent.exe"
#define MyAppInstallDir "{pf}\TestAgent"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={#MyAppInstallDir}
DefaultGroupName={#MyAppName}
OutputDir=dist
OutputBaseFilename=testagent-setup-{#MyAppVersion}
SetupIconFile=..\packages\app\public\favicon.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ChangesEnvironment=yes
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "addtopath"; Description: "Add {#MyAppName} to PATH (recommended)"; GroupDescription: "Environment:"

[Files]
; 把 testagent.exe 和 opencode.cmd 放到 installer/ 同级的 dist-win/ 目录下再编译
Source: "..\dist-win\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist-win\opencode.cmd"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Registry]
; 写入系统级 PATH（需要管理员，已在 PrivilegesRequired=admin 保证）
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; \
    ValueType: expandsz; ValueName: "Path"; \
    ValueData: "{olddata};{app}"; \
    Check: NeedsAddPath(ExpandConstant('{app}')); \
    Tasks: addtopath

[Code]
// 检查目录是否已经在 PATH 里，避免重复添加
function NeedsAddPath(Dir: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(
    HKEY_LOCAL_MACHINE,
    'SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
    'Path',
    OrigPath
  ) then begin
    Result := true;
    exit;
  end;
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(OrigPath) + ';') = 0;
end;

// 卸载时从 PATH 移除
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  OrigPath: string;
  Dir: string;
  P: Integer;
begin
  if CurUninstallStep <> usPostUninstall then exit;

  Dir := ExpandConstant('{app}');
  if not RegQueryStringValue(
    HKEY_LOCAL_MACHINE,
    'SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
    'Path',
    OrigPath
  ) then exit;

  P := Pos(';' + Uppercase(Dir), ';' + Uppercase(OrigPath));
  if P = 0 then exit;

  // 删除 ;dir 这一段
  Delete(OrigPath, P - 1, Length(Dir) + 1);
  RegWriteStringValue(
    HKEY_LOCAL_MACHINE,
    'SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
    'Path',
    OrigPath
  );
end;
