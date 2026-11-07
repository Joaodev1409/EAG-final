# Despachante de agentes: usa as Issues do GitHub (remote "meu") como fila.
#
# Uso (na raiz do EAG, Windows PowerShell 5.1):
#   powershell -ExecutionPolicy Bypass -File scripts\agentes\despachante.ps1 -Acao preparar   # labels + exclusões do git
#   powershell -ExecutionPolicy Bypass -File scripts\agentes\despachante.ps1 -Acao planejar   # cria até N issues "proposta"
#   powershell -ExecutionPolicy Bypass -File scripts\agentes\despachante.ps1 -Acao uma-vez    # uma passada do loop
#   powershell -ExecutionPolicy Bypass -File scripts\agentes\despachante.ps1 -Acao loop       # roda a cada N minutos
#   powershell -ExecutionPolicy Bypass -File scripts\agentes\despachante.ps1 -Acao status
#
# Para parar o loop: crie um arquivo chamado PARAR na raiz do EAG.
# Fluxo do João: revisar as issues "proposta" e trocar a label para "aprovada"; revisar e fazer merge dos PRs.
param(
  [ValidateSet("preparar", "planejar", "uma-vez", "loop", "status")]
  [string]$Acao = "status",
  [string]$Config = ""
)

$ErrorActionPreference = "Continue"   # erros de comandos nativos são tratados por $LASTEXITCODE
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$Utf8SemBom = New-Object Text.UTF8Encoding $false

# ---------------------------------------------------------------- utilitários

function Write-Utf8([string]$Caminho, [string]$Texto) {
  $dir = Split-Path $Caminho -Parent
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  [IO.File]::WriteAllText($Caminho, $Texto, $Utf8SemBom)
}

function Log([string]$Msg, [string]$Nivel = "INFO") {
  $linha = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Nivel, $Msg
  $cor = @{ INFO = "Gray"; OK = "Green"; AVISO = "Yellow"; ERRO = "Red" }[$Nivel]
  if (-not $cor) { $cor = "Gray" }
  Write-Host $linha -ForegroundColor $cor
  if ($script:DirLogs) {
    $arq = Join-Path $script:DirLogs ("despachante-" + (Get-Date -Format "yyyy-MM-dd") + ".log")
    [IO.File]::AppendAllText($arq, $linha + "`r`n", $Utf8SemBom)
  }
}

function Ultimas([string]$Texto, [int]$Linhas = 120, [int]$MaxChars = 12000) {
  if (-not $Texto) { return "" }
  $l = $Texto -split "`r?`n"
  if ($l.Count -gt $Linhas) { $l = $l[($l.Count - $Linhas)..($l.Count - 1)] }
  $t = ($l -join "`n")
  if ($t.Length -gt $MaxChars) { $t = $t.Substring($t.Length - $MaxChars) }
  return $t
}

# Monta a linha de argumentos do Windows (Start-Process só aceita uma string no PS 5.1).
function Format-Args([string[]]$Lista) {
  ($Lista | ForEach-Object {
    $a = [string]$_
    if ($a -eq "") { '""' }
    elseif ($a -match '[\s"]') { '"' + ($a -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
    else { $a }
  }) -join " "
}

# Roda um processo com timeout, salvando stdout/stderr em arquivos. Mata a árvore inteira se passar do tempo.
function Invoke-Processo([string]$Exe, [string[]]$Argumentos, [string]$Dir, [double]$TimeoutMin, [string]$Rotulo) {
  $base = Join-Path $script:DirLogs ("{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), ($Rotulo -replace '[^\w\-]', '_'))
  $out = "$base.out.txt"; $err = "$base.err.txt"
  if ($TimeoutMin -le 0) { $TimeoutMin = 1 }
  $argLinha = Format-Args $Argumentos
  Log "Rodando ($Rotulo, timeout $([math]::Round($TimeoutMin,1)) min): $Exe $argLinha"
  $vazio = "$base.in.txt"; Write-Utf8 $vazio ""
  $p = Start-Process -FilePath $Exe -ArgumentList $argLinha -WorkingDirectory $Dir -NoNewWindow -PassThru `
         -RedirectStandardOutput $out -RedirectStandardError $err -RedirectStandardInput $vazio
  $null = $p.Handle   # sem isso o PS 5.1 perde o ExitCode
  $estourou = -not $p.WaitForExit([int]($TimeoutMin * 60000))
  if ($estourou) {
    Log "Timeout em $Rotulo; encerrando a árvore de processos (PID $($p.Id))." "AVISO"
    & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
    $p.WaitForExit(10000) | Out-Null
  }
  $saida = ""; $erro = ""
  if (Test-Path $out) { $saida = [IO.File]::ReadAllText($out, [Text.Encoding]::UTF8) }
  if (Test-Path $err) { $erro = [IO.File]::ReadAllText($err, [Text.Encoding]::UTF8) }
  $codigo = if ($estourou) { -1 } else { $p.ExitCode }
  return [pscustomobject]@{ Codigo = $codigo; Saida = $saida; Erro = $erro; Timeout = $estourou; Log = $out }
}

function Git([string]$Dir, [string[]]$Argumentos) {
  $r = & (Get-Exe "git") -C $Dir @Argumentos 2>&1 | ForEach-Object { "$_" }
  $script:GitCodigo = $LASTEXITCODE
  return ($r -join "`n")
}

function Gh([string[]]$Argumentos, [switch]$Json) {
  $r = & (Get-Exe "gh") @Argumentos 2>&1 | ForEach-Object { "$_" }
  $codigo = $LASTEXITCODE
  $texto = ($r -join "`n")
  if ($codigo -ne 0) { throw "gh $($Argumentos -join ' ') falhou ($codigo): $texto" }
  if ($Json) { if ($texto.Trim()) { return ($texto | ConvertFrom-Json) } else { return @() } }
  return $texto
}

# ---------------------------------------------------------------- caminhos permitidos

# Converte um glob (server/**, client/src/admin/*.jsx, server/) em regex.
function ConvertTo-RegexGlob([string]$Glob) {
  $g = $Glob.Trim().Trim('`').Replace('\', '/')
  if ($g.StartsWith("./")) { $g = $g.Substring(2) }
  if ($g.EndsWith("/")) { $g += "**" }
  $rx = [regex]::Escape($g)
  $rx = $rx.Replace('\*\*/', '(.*/)?').Replace('\*\*', '.*').Replace('\*', '[^/]*').Replace('\?', '[^/]')
  return "^$rx$"
}

function Test-CaminhoPermitido([string]$Arquivo, [string[]]$Globs) {
  $a = $Arquivo.Replace('\', '/')
  foreach ($bloq in $script:SempreProibidos) { if ($a -match (ConvertTo-RegexGlob $bloq)) { return $false } }
  foreach ($g in $Globs) { if ($a -match (ConvertTo-RegexGlob $g)) { return $true } }
  return $false
}

# Extrai os caminhos da linha "**Caminhos permitidos:** `a`, `b`" do corpo da issue.
function Get-CaminhosDaIssue([string]$Corpo) {
  $m = [regex]::Match($Corpo, '(?im)^\s*\**\s*caminhos(?: permitidos)?\s*:?\s*\**\s*:?\s*(.+)$')
  if (-not $m.Success) { return @() }
  $itens = [regex]::Matches($m.Groups[1].Value, '`([^`]+)`') | ForEach-Object { $_.Groups[1].Value.Trim() }
  return @($itens | Where-Object { $_ })
}

$script:SempreProibidos = @(
  "**/.env", "**/.env.*", ".env", ".env.*",
  ".dados-local/**", ".dados-teste/**", ".evento/**", ".pgdata/**",
  "TASKS.md", "AGENTS.md", "CLAUDE.md", "scripts/agentes/**"
)

# ---------------------------------------------------------------- estado e travas

function Test-Parar { return (Test-Path (Join-Path $script:Raiz "PARAR")) }

function Get-Estado {
  $hoje = Get-Date -Format "yyyy-MM-dd"
  $arq = Join-Path $script:DirEstado "estado.json"
  if (Test-Path $arq) {
    $e = [IO.File]::ReadAllText($arq, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($e.data -eq $hoje) { return $e }
  }
  return [pscustomobject]@{ data = $hoje; tasks = 0 }
}

function Add-TaskDoDia {
  $e = Get-Estado
  $e.tasks = [int]$e.tasks + 1
  Write-Utf8 (Join-Path $script:DirEstado "estado.json") ($e | ConvertTo-Json)
}

function Test-LimiteDoDia { return ([int](Get-Estado).tasks -ge [int]$script:Cfg.limiteTasksPorDia) }

# Nunca empurra para a main: só branches tarefa/*.
function Push-Seguro([string]$Dir, [string]$Branch) {
  if ($Branch -notmatch '^tarefa/[\w\-]+$' -or $Branch -match '^(main|master)$' -or $Branch -eq $script:Cfg.branchBase) {
    throw "Push recusado para a branch '$Branch' (só tarefa/*)."
  }
  $atual = (Git $Dir @("rev-parse", "--abbrev-ref", "HEAD")).Trim()
  if ($atual -ne $Branch) { throw "Push recusado: HEAD está em '$atual', não em '$Branch'." }
  $r = Git $Dir @("push", $script:Cfg.remote, "HEAD:refs/heads/$Branch")
  if ($script:GitCodigo -ne 0) { throw "git push falhou: $r" }
}

function Preparar-Exclusoes {
  $comum = (Git $script:Raiz @("rev-parse", "--git-common-dir")).Trim()
  if (-not [IO.Path]::IsPathRooted($comum)) { $comum = Join-Path $script:Raiz $comum }
  $exclude = Join-Path $comum "info\exclude"
  $atual = if (Test-Path $exclude) { [IO.File]::ReadAllText($exclude) } else { "" }
  foreach ($linha in @(".agentes/", "/PARAR")) {
    if ($atual -notmatch [regex]::Escape($linha)) { [IO.File]::AppendAllText($exclude, "`n$linha", $Utf8SemBom); Log "Adicionado '$linha' ao .git/info/exclude." }
  }
}

function Preparar-Labels {
  $existentes = @(Gh @("label", "list", "--repo", $script:Cfg.repo, "--limit", "200", "--json", "name") -Json | ForEach-Object { $_.name })
  foreach ($p in $script:Cfg.labels.PSObject.Properties) {
    if ($existentes -contains $p.Name) { continue }
    Gh @("label", "create", $p.Name, "--repo", $script:Cfg.repo, "--color", $p.Value.cor, "--description", $p.Value.descricao) | Out-Null
    Log "Label criada: $($p.Name)" "OK"
  }
}

# ---------------------------------------------------------------- execução dos agentes

# Resolve o executável de verdade. "& git" dentro da função Git chamaria a própria função
# (o PowerShell não diferencia maiúsculas), por isso as chamadas usam este caminho.
$script:CacheExe = @{}
function Get-Exe([string]$Nome) {
  if ($script:CacheExe.ContainsKey($Nome)) { return $script:CacheExe[$Nome] }
  foreach ($n in @("$Nome.exe", "$Nome.cmd", $Nome)) {
    $c = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { $script:CacheExe[$Nome] = $c.Source; return $c.Source }
  }
  if ($Nome -eq "gh" -and (Test-Path "C:\Program Files\GitHub CLI\gh.exe")) { $script:CacheExe[$Nome] = "C:\Program Files\GitHub CLI\gh.exe"; return $script:CacheExe[$Nome] }
  throw "Não achei o executável '$Nome' no PATH."
}

# Permissões do Claude por execução: nada de --dangerously-skip-permissions.
# dontAsk = recusa tudo o que não estiver na lista "allow".
function New-ConfigClaude([string]$Modo, [string[]]$Caminhos, [string]$Rotulo) {
  $deny = @(
    "Bash(git push:*)", "Bash(git merge:*)", "Bash(git rebase:*)", "Bash(git reset:*)", "Bash(git checkout:*)",
    "Bash(git switch:*)", "Bash(git commit:*)", "Bash(npm run importar:*)", "Bash(npm run lancar-nuvem:*)",
    "Bash(npm run dev:*)", "Bash(npm run local:*)", "Bash(gh:*)", "Bash(curl:*)", "WebFetch", "WebSearch",
    "PowerShell(git push:*)", "PowerShell(git merge:*)", "PowerShell(git rebase:*)", "PowerShell(git reset:*)",
    "PowerShell(git checkout:*)", "PowerShell(git switch:*)", "PowerShell(git commit:*)", "PowerShell(npm run importar:*)",
    "PowerShell(npm run lancar-nuvem:*)", "PowerShell(npm run dev:*)", "PowerShell(npm run local:*)", "PowerShell(gh:*)",
    "Read(**/.env)", "Read(**/.env.*)", "Edit(**/.env)", "Edit(**/.env.*)", "Edit(TASKS.md)", "Edit(AGENTS.md)",
    "Edit(CLAUDE.md)", "Edit(scripts/agentes/**)", "Edit(.dados-local/**)", "Edit(.dados-teste/**)", "Edit(.evento/**)"
  )
  $allow = @("Read", "Glob", "Grep")
  if ($Modo -eq "tarefa") {
    $allow += @("Bash(npm run build)", "Bash(npm test)", "Bash(npm test --prefix server)", "Bash(npm test --prefix server:*)",
                "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "TodoWrite",
                # No Windows o Claude roda comandos pela ferramenta PowerShell; as regras Bash(...) não valem para ela.
                "PowerShell(npm run build)", "PowerShell(npm test)", "PowerShell(npm test --prefix server)",
                "PowerShell(npm test --prefix server:*)", "PowerShell(git status:*)", "PowerShell(git diff:*)", "PowerShell(git log:*)")
    foreach ($c in $Caminhos) {
      $g = $c.Trim().Trim('`').Replace('\', '/'); if ($g.EndsWith("/")) { $g += "**" }
      $allow += "Edit($g)"
    }
  } else {
    $deny += @("Edit", "Write", "NotebookEdit", "Bash", "PowerShell")
  }
  $cfg = @{ permissions = @{ allow = $allow; deny = $deny; defaultMode = "dontAsk" } }
  $arq = Join-Path $script:DirPrompts "$Rotulo.settings.json"
  Write-Utf8 $arq ($cfg | ConvertTo-Json -Depth 5)
  return $arq
}

function Invoke-Agente([string]$Agente, [string]$Modo, [string]$ArqPrompt, [string]$Dir, [string[]]$Caminhos, [double]$TimeoutMin, [string]$Rotulo, [string[]]$DirsExtras = @()) {
  $a = $script:Cfg.agentes.$Agente
  $curto = "Leia o arquivo $ArqPrompt e siga exatamente as instrucoes dele."
  if ($a.cli -eq "claude") {
    $settings = New-ConfigClaude $Modo $Caminhos $Rotulo
    $argv = @("-p", $curto, "--settings", $settings, "--permission-mode", "dontAsk", "--output-format", "text",
              "--no-session-persistence", "--strict-mcp-config", "--add-dir", $script:DirPrompts)
    foreach ($d in $DirsExtras) { $argv += @("--add-dir", $d) }
    if ($script:Cfg.orcamentoUsdPorExecucaoClaude) { $argv += @("--max-budget-usd", [string]$script:Cfg.orcamentoUsdPorExecucaoClaude) }
    if ($a.modelo) { $argv += @("--model", $a.modelo) }
  } else {
    $extra = if ($Modo -eq "tarefa") { @($a.argsTarefa) } else { @($a.argsRevisao) }
    $argv = @($extra) + @("-p", $curto, "--add-dir", $script:DirPrompts)
    # O agy só aceita regra de comando exata (ou "*", que libera tudo). Sem a regra, ele recusa
    # o comando e encerra a execução inteira, então a lista vai num arquivo de settings.
    if ($Modo -eq "tarefa" -and $a.comandosPermitidos) {
      $regras = @($a.comandosPermitidos | ForEach-Object { "command($_)" })
      $arqSettings = Join-Path $script:DirPrompts "$Rotulo.agy-settings.json"
      Write-Utf8 $arqSettings (@{ permissions = @{ allow = $regras } } | ConvertTo-Json -Depth 4)
      $argv += @("--settings", $arqSettings)
    }
    foreach ($d in $DirsExtras) { $argv += @("--add-dir", $d) }
    if ($a.modelo) { $argv += @("--model", $a.modelo) }
  }
  return Invoke-Processo (Get-Exe $a.cli) $argv $Dir $TimeoutMin $Rotulo
}

# ---------------------------------------------------------------- planejador

function Invoke-Planejador {
  $cfg = $script:Cfg
  $abertas = @(Gh @("issue", "list", "--repo", $cfg.repo, "--state", "open", "--limit", "100", "--json", "number,title,labels,body") -Json)
  $propostas = @($abertas | Where-Object { $_.labels.name -contains "proposta" })
  $vagas = [int]$cfg.maxPropostas - $propostas.Count
  if ($vagas -le 0) { Log "Já existem $($propostas.Count) issues 'proposta' abertas; nada a planejar."; return }

  $lista = ($abertas | ForEach-Object { "- #$($_.number) [$(($_.labels.name) -join ', ')] $($_.title)`n  $((Ultimas $_.body 15 1500) -replace "`n", "`n  ")" }) -join "`n"
  if (-not $lista) { $lista = "(nenhuma)" }
  $prompt = @"
Voce e o planejador do repositorio EAG (pasta atual). Trabalhe SO lendo arquivos: nao edite nada e nao rode comandos.

1. Leia AGENTS.md, TASKS.md e README.md e olhe o codigo de server/ e client/.
2. Considere as issues abertas abaixo para nao repetir trabalho.
3. Proponha ate $vagas tasks novas, pequenas (cabem em uma sessao de agente), uteis e verificaveis.

Regras das tasks (mesmo formato do TASKS.md):
- dono "claude" para tasks em server/ (e api/); dono "antigravity" para tasks em client/. Uma task nunca mistura server/ e client/.
- caminhos: globs exatos dos arquivos que a task pode tocar (ex.: "server/src/routes/orders.js", "server/test/**").
- Nunca proponha mexer em .env*, .dados-*, .evento/, TASKS.md, AGENTS.md, scripts/agentes/, nem editar migracoes existentes em server/src/db.js.
- Respeite as regras financeiras do README.
- criterio_pronto: como verificar (build, testes, comportamento observavel).

Responda APENAS com um array JSON, sem texto antes ou depois, neste formato:
[{"titulo": "...", "dono": "claude", "caminhos": ["server/..."], "descricao": "...", "criterio_pronto": "..."}]

Issues abertas:
$lista
"@
  $rot = "planejador-" + (Get-Date -Format "yyyyMMdd-HHmmss")
  $arq = Join-Path $script:DirPrompts "$rot.md"
  Write-Utf8 $arq $prompt
  $r = Invoke-Agente "claude" "leitura" $arq $script:Raiz @() $cfg.timeoutPlanejadorMinutos $rot
  if ($r.Codigo -ne 0) { Log "Planejador falhou ($($r.Codigo)): $(Ultimas ($r.Erro + $r.Saida) 20)" "ERRO"; return }

  $txt = $r.Saida
  $i = $txt.IndexOf("["); $f = $txt.LastIndexOf("]")
  # O ForEach-Object abaixo desmonta o array: no PS 5.1 o ConvertFrom-Json entrega o array inteiro como um item só.
  if ($i -lt 0 -or $f -le $i) { Log "Planejador não devolveu JSON. Saída em $($r.Log)" "ERRO"; return }
  try { $tasks = @($txt.Substring($i, $f - $i + 1) | ConvertFrom-Json | ForEach-Object { $_ }) } catch { Log "JSON inválido do planejador: $_" "ERRO"; return }

  $criadas = 0
  foreach ($t in $tasks) {
    if ($criadas -ge $vagas) { break }
    $caminhos = @($t.caminhos | ForEach-Object { ([string]$_).Trim().Replace('\', '/') } | Where-Object { $_ })
    if (-not $t.titulo -or $caminhos.Count -eq 0) { Log "Proposta sem título ou caminhos; ignorada." "AVISO"; continue }
    $server = @($caminhos | Where-Object { $_ -match '^(server|api)/' }).Count
    $client = @($caminhos | Where-Object { $_ -match '^client/' }).Count
    if ($server -gt 0 -and $client -gt 0) { Log "Proposta '$($t.titulo)' mistura server e client; ignorada." "AVISO"; continue }
    if ($server + $client -ne $caminhos.Count) { Log "Proposta '$($t.titulo)' tem caminhos fora de server/client; ignorada." "AVISO"; continue }
    $proibido = @($caminhos | Where-Object { -not (Test-CaminhoPermitido ($_ -replace '\*+', 'x') @("**")) })
    if ($proibido.Count) { Log "Proposta '$($t.titulo)' toca caminho proibido ($($proibido -join ', ')); ignorada." "AVISO"; continue }
    $dono = if ($server -gt 0) { "claude" } else { "antigravity" }

    $corpo = @"
**Dono:** $dono
**Caminhos permitidos:** $(($caminhos | ForEach-Object { '`' + $_ + '`' }) -join ", ")

## O que fazer
$($t.descricao)

## Pronto quando
$($t.criterio_pronto)
- ``npm run build`` sem erro e ``npm test --prefix server`` passando.

---
_Proposta pelo planejador automático. Para liberar, troque a label ``proposta`` por ``aprovada``._
"@
    $arqCorpo = Join-Path $script:DirPrompts "$rot-issue$criadas.md"
    Write-Utf8 $arqCorpo $corpo
    $titulo = ([string]$t.titulo).Replace('"', "'")
    $url = Gh @("issue", "create", "--repo", $cfg.repo, "--title", $titulo, "--body-file", $arqCorpo,
                "--label", "proposta", "--label", $cfg.agentes.$dono.label)
    Log "Issue criada ($dono): $titulo -> $url" "OK"
    $criadas++
  }
  Log "Planejador terminou: $criadas proposta(s) criada(s)."
}

# ---------------------------------------------------------------- tarefa e revisão

function Get-ProximaIssue([string]$Agente) {
  $cfg = $script:Cfg
  $label = $cfg.agentes.$Agente.label
  $minhas = @(Gh @("issue", "list", "--repo", $cfg.repo, "--state", "open", "--label", $label, "--limit", "100",
                   "--json", "number,title,body,createdAt,labels") -Json)
  $ocupado = @($minhas | Where-Object { $_.labels.name -contains "em-andamento" })
  if ($ocupado.Count) { Log "$Agente está ocupado com #$($ocupado[0].number) (label em-andamento)."; return $null }
  $fila = @($minhas | Where-Object {
      $n = @($_.labels.name)
      ($n -contains "aprovada") -and -not ($n -contains "falhou") -and -not ($n -contains "pr-aberto")
    } | Sort-Object { [datetime]$_.createdAt })
  if ($fila.Count -eq 0) { return $null }
  return $fila[0]
}

function Get-ArquivosAlterados([string]$Dir, [string]$Base) {
  $a = @((Git $Dir @("diff", "--name-only", $Base)) -split "`n")
  $a += @((Git $Dir @("ls-files", "--others", "--exclude-standard")) -split "`n")
  return @($a | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object -Unique)
}

function Set-Labels([int]$Numero, [string[]]$Adicionar, [string[]]$Remover) {
  $argv = @("issue", "edit", [string]$Numero, "--repo", $script:Cfg.repo)
  foreach ($l in $Adicionar) { $argv += @("--add-label", $l) }
  foreach ($l in $Remover) { $argv += @("--remove-label", $l) }
  Gh $argv | Out-Null
}

function Comentar([string]$Tipo, [string]$Numero, [string]$Texto, [string]$Rot) {
  $arq = Join-Path $script:DirPrompts "$Rot-comentario.md"
  Write-Utf8 $arq $Texto
  Gh @($Tipo, "comment", $Numero, "--repo", $script:Cfg.repo, "--body-file", $arq) | Out-Null
}

function Invoke-Verificacao([string]$Dir, [double]$TimeoutMin, [string]$Rot) {
  foreach ($cmd in $script:Cfg.comandosVerificacao) {
    $r = Invoke-Processo "cmd.exe" (@("/d", "/c") + ($cmd -split ' ')) $Dir $TimeoutMin "$Rot-verif"
    if ($r.Codigo -ne 0) {
      $motivo = if ($r.Timeout) { "estourou o tempo" } else { "saiu com código $($r.Codigo)" }
      return [pscustomobject]@{ Ok = $false; Texto = "O comando ``$cmd`` $motivo.`n`n" + (Ultimas ($r.Saida + "`n" + $r.Erro) 150) }
    }
  }
  return [pscustomobject]@{ Ok = $true; Texto = "" }
}

function Invoke-Tarefa([string]$Agente) {
  $cfg = $script:Cfg
  $ag = $cfg.agentes.$Agente
  $dir = (Resolve-Path (Join-Path $script:Raiz $ag.worktree)).Path
  $base = "$($cfg.remote)/$($cfg.branchBase)"

  $issue = Get-ProximaIssue $Agente
  if (-not $issue) { Log "Nada aprovado para $Agente."; return }
  $n = [int]$issue.number
  $rot = "issue$n-$Agente"
  Log "== $Agente pega a issue #${n}: $($issue.title) ==" "OK"

  # Worktree precisa estar limpa (nada de mudança perdida de outra sessão).
  $sujeira = Git $dir @("status", "--porcelain", "--untracked-files=no")
  if ($sujeira.Trim()) {
    Log "Worktree $dir tem mudanças não commitadas; $Agente pulado. Limpe e rode de novo:`n$sujeira" "AVISO"
    return
  }

  Set-Labels $n @("em-andamento") @("aprovada")
  Add-TaskDoDia
  $inicio = Get-Date
  $prazo = $inicio.AddMinutes([double]$cfg.timeoutTaskMinutos)
  $restante = { [math]::Max(0.5, ($prazo - (Get-Date)).TotalMinutes) }

  try {
    # 1. Atualiza a branch do agente com a main do remoto (nunca o contrário).
    Git $dir @("fetch", $cfg.remote, "--prune") | Out-Null
    if ($script:GitCodigo -ne 0) { throw "git fetch falhou." }
    $sw = Git $dir @("switch", $ag.branch)
    if ($script:GitCodigo -ne 0) { throw "Não consegui ir para $($ag.branch): $sw" }
    $atual = (Git $dir @("rev-parse", "--abbrev-ref", "HEAD")).Trim()
    if ($atual -ne $ag.branch -or $atual -eq $cfg.branchBase) { throw "Recusado: merge só na branch do agente (HEAD em '$atual')." }
    $mg = Git $dir @("-c", "core.editor=true", "merge", "--no-edit", $base)
    if ($script:GitCodigo -ne 0) {
      Git $dir @("merge", "--abort") | Out-Null
      throw "git merge $base em $($ag.branch) deu conflito:`n$mg"
    }
    $branch = "tarefa/$Agente-$n"
    $sw = Git $dir @("switch", "-C", $branch)
    if ($script:GitCodigo -ne 0) { throw "Não consegui criar $branch : $sw" }
    $shaInicial = (Git $dir @("rev-parse", "HEAD")).Trim()

    $caminhos = @(Get-CaminhosDaIssue $issue.body)
    if ($caminhos.Count -eq 0) { $caminhos = @($ag.caminhosPadrao); Log "Issue sem 'Caminhos permitidos'; usando $($caminhos -join ', ')." "AVISO" }

    $avisoComandos = ""
    if ($ag.comandosPermitidos) {
      $avisoComandos = "- Comandos de terminal: SO estes, exatamente assim: " + (($ag.comandosPermitidos | ForEach-Object { [string][char]96 + $_ + [char]96 }) -join ", ") +
        ". Qualquer outro comando (inclusive para ler arquivos, imagens ou buscar texto) e recusado e derruba a execucao inteira; para ler e buscar, use as suas ferramentas de arquivo."
    }
    $erroAnterior = ""; $resumo = ""; $ok = $false
    for ($t = 1; $t -le [int]$cfg.maxTentativas; $t++) {
      if ((Get-Date) -ge $prazo) { $erroAnterior = "Tempo da task esgotado ($($cfg.timeoutTaskMinutos) min).`n`n$erroAnterior"; break }
      $prompt = @"
Voce e o agente "$Agente" trabalhando na worktree $dir (branch $branch).
Siga o AGENTS.md deste repositorio. A sua task e a issue #$n do GitHub, copiada abaixo; ela substitui a busca no TASKS.md.

Regras desta execucao (automatica, sem ninguem olhando):
- Mexa SOMENTE nestes caminhos: $($caminhos -join ', ').
- Nao faca commit, push, merge, rebase, checkout nem troque de branch: o despachante faz isso.
- Nao rode npm run dev, npm run local, importar nem lancar-nuvem. Nao acesse a internet.
- Para conferir, voce pode rodar ``npm run build`` e ``npm test --prefix server``.
$avisoComandos
- Se precisar de arquivo fora dos caminhos, NAO mexa: explique no resumo.
- Termine com o resumo pedido no AGENTS.md (o que mudou, arquivos tocados, como testar manualmente, riscos).

## Issue #${n}: $($issue.title)

$($issue.body)
"@
      if ($erroAnterior) {
        $prompt += "`n`n## Tentativa anterior falhou (tentativa $t de $($cfg.maxTentativas))`nCorrija o problema abaixo sem sair dos caminhos permitidos:`n`n$erroAnterior`n"
      }
      $arq = Join-Path $script:DirPrompts "$rot-t$t.md"
      Write-Utf8 $arq $prompt

      $r = Invoke-Agente $Agente "tarefa" $arq $dir $caminhos (& $restante) "$rot-t$t"
      $resumo = Ultimas $r.Saida 80 6000
      if ($r.Timeout) { $erroAnterior = "O agente estourou o tempo da task."; break }
      if ($r.Codigo -ne 0) { $erroAnterior = "O agente saiu com código $($r.Codigo).`n`n$(Ultimas ($r.Erro + "`n" + $r.Saida) 60)"; continue }

      # Trava de caminhos: confere tudo o que mudou em relação à base.
      $alterados = @(Get-ArquivosAlterados $dir $shaInicial)
      $fora = @($alterados | Where-Object { -not (Test-CaminhoPermitido $_ $caminhos) })
      if ($fora.Count) {
        $erroAnterior = "Arquivos alterados fora dos caminhos permitidos: $($fora -join ', '). Desfaca essas mudancas."
        Log $erroAnterior "AVISO"; continue
      }
      if ($alterados.Count -eq 0) { $erroAnterior = "Nenhum arquivo foi alterado."; continue }

      Git $dir @("add", "-A", "--", ".") | Out-Null
      $pendente = Git $dir @("diff", "--cached", "--name-only")
      if ($pendente.Trim()) {
        $msg = "#${n}: $($issue.title)" + $(if ($t -gt 1) { " (tentativa $t)" } else { "" })
        $c = Git $dir @("commit", "-m", $msg)
        if ($script:GitCodigo -ne 0) { throw "git commit falhou: $c" }
      }

      $v = Invoke-Verificacao $dir (& $restante) "$rot-t$t"
      if ($v.Ok) { $ok = $true; break }
      $erroAnterior = $v.Texto
      Log "Tentativa $t de #$n falhou na verificação." "AVISO"
    }

    if (-not $ok) {
      Set-Labels $n @("falhou") @("em-andamento")
      Comentar "issue" $n "O agente **$Agente** não concluiu esta task depois de até $($cfg.maxTentativas) tentativa(s). A branch local ``$branch`` ficou na worktree ``$($ag.worktree)`` para conferência.`n`n<details><summary>Último erro</summary>`n`n``````text`n$erroAnterior`n```````n</details>`n`n<details><summary>Resumo do agente</summary>`n`n$resumo`n</details>" $rot
      Log "#$n marcada como falhou." "ERRO"
      return
    }

    # 2. Push da branch da task e PR para a main (merge fica com o João).
    Push-Seguro $dir $branch
    $corpoPr = "Closes #$n`n`nTask executada automaticamente pelo agente **$Agente** (``npm run build`` e ``npm test --prefix server`` passaram).`n`n## Resumo do agente`n`n$resumo"
    $arqPr = Join-Path $script:DirPrompts "$rot-pr.md"
    Write-Utf8 $arqPr $corpoPr
    $titulo = ([string]$issue.title).Replace('"', "'")
    $url = Gh @("pr", "create", "--repo", $cfg.repo, "--base", $cfg.branchBase, "--head", $branch,
                "--title", "#${n}: $titulo", "--body-file", $arqPr, "--label", "pr-aberto")
    $pr = ([regex]::Match($url, '/pull/(\d+)')).Groups[1].Value
    Set-Labels $n @("pr-aberto") @("em-andamento")
    Log "PR aberto para #${n}: $url" "OK"

    # 3. Revisão cruzada pelo outro agente (só leitura).
    if ($pr) { Invoke-Revisao $Agente $dir $branch $pr $n $base $issue.title $issue.body }
  }
  catch {
    Log "Erro na issue #${n}: $_" "ERRO"
    try {
      Set-Labels $n @("falhou") @("em-andamento")
      Comentar "issue" $n "O despachante parou esta task com erro: ``$($_.ToString().Replace([string][char]96, "'"))``" $rot
    } catch { Log "Também não consegui atualizar a issue: $_" "ERRO" }
  }
  finally {
    Log "Issue #$n levou $([math]::Round(((Get-Date) - $inicio).TotalMinutes, 1)) min."
  }
}

function Invoke-Revisao([string]$Autor, [string]$DirAutor, [string]$Branch, [string]$Pr, [int]$Issue, [string]$Base, [string]$TituloIssue = "", [string]$CorpoIssue = "") {
  $cfg = $script:Cfg
  $revisor = @($cfg.agentes.PSObject.Properties.Name | Where-Object { $_ -ne $Autor })[0]
  if (-not $revisor) { return }
  $dirRev = (Resolve-Path (Join-Path $script:Raiz $cfg.agentes.$revisor.worktree)).Path
  $rot = "pr$Pr-revisao-$revisor"
  $diff = Git $DirAutor @("diff", "$Base...$Branch")
  $arqDiff = Join-Path $script:DirPrompts "$rot.diff"
  Write-Utf8 $arqDiff $diff
  $prompt = @"
Voce e o agente "$revisor" fazendo revisao cruzada do PR #$Pr (issue #$Issue), feito pelo agente "$Autor".
NAO edite nenhum arquivo e nao rode comandos que alterem algo.

O diff completo esta em $arqDiff. O codigo da branch esta em $DirAutor (so leitura).
A task pedida e a issue #$Issue, copiada no fim deste arquivo: ela substitui a busca no TASKS.md. Confira se o diff cumpre o "Pronto quando" e se ficou so nos "Caminhos permitidos".
Revise seguindo o AGENTS.md: aponte bugs, quebra de regra (caminhos, migracoes, regras financeiras do README), mudanca de comportamento nao pedida, item do "Pronto quando" nao atendido e falta de teste.
Responda em portugues, em Markdown, com: veredito (aprovar / pedir mudancas), lista de problemas com arquivo e linha, e sugestoes opcionais. Seja objetivo.
"@
  if ($CorpoIssue) { $prompt += "`n`n## Issue #${Issue}: $TituloIssue`n`n$CorpoIssue`n" }
  $arq = Join-Path $script:DirPrompts "$rot.md"
  Write-Utf8 $arq $prompt
  $antes = Git $dirRev @("status", "--porcelain")
  $r = Invoke-Agente $revisor "leitura" $arq $dirRev @() $cfg.timeoutRevisaoMinutos $rot @($DirAutor)
  $depois = Git $dirRev @("status", "--porcelain")
  if ($antes -ne $depois) { Log "ATENÇÃO: a worktree do revisor ($dirRev) mudou durante a revisão. Confira à mão." "AVISO" }
  if ($r.Codigo -ne 0 -or -not $r.Saida.Trim()) { Log "Revisão de $revisor falhou ($($r.Codigo)); PR #$Pr fica sem comentário." "AVISO"; return }
  Comentar "pr" $Pr "## Revisão cruzada automática ($revisor)`n`n$(Ultimas $r.Saida 300 60000)" $rot
  Log "Revisão de $revisor postada no PR #$Pr." "OK"
}

# ---------------------------------------------------------------- loop

function Invoke-Passada {
  foreach ($nome in $script:Cfg.agentes.PSObject.Properties.Name) {
    if (Test-Parar) { Log "Arquivo PARAR encontrado; encerrando." "AVISO"; return $false }
    if (Test-LimiteDoDia) { Log "Limite de $($script:Cfg.limiteTasksPorDia) tasks por dia atingido." "AVISO"; return $true }
    Invoke-Tarefa $nome
  }
  return $true
}

function Show-Status {
  $e = Get-Estado
  Log "Hoje: $($e.tasks)/$($script:Cfg.limiteTasksPorDia) tasks. PARAR: $(Test-Parar)."
  foreach ($l in @("proposta", "aprovada", "em-andamento", "pr-aberto", "falhou")) {
    $is = @(Gh @("issue", "list", "--repo", $script:Cfg.repo, "--state", "open", "--label", $l, "--json", "number,title") -Json)
    Log ("{0,-13} {1}" -f $l, (($is | ForEach-Object { "#$($_.number) $($_.title)" }) -join " | "))
  }
}

function Main {
  $aqui = Split-Path -Parent $PSCommandPath
  $script:Raiz = (& (Get-Exe "git") -C $aqui rev-parse --show-toplevel).Trim().Replace('/', '\')
  if (-not $Config) { $Config = Join-Path $aqui "config.json" }
  $script:Cfg = [IO.File]::ReadAllText($Config, [Text.Encoding]::UTF8) | ConvertFrom-Json
  $script:DirEstado = Join-Path $script:Raiz ".agentes"
  $script:DirLogs = Join-Path $script:DirEstado "logs"
  $script:DirPrompts = Join-Path $script:DirEstado "prompts"
  foreach ($d in @($script:DirLogs, $script:DirPrompts)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null } }
  Preparar-Exclusoes
  Get-Exe "gh" | Out-Null

  switch ($Acao) {
    "preparar" { Preparar-Labels }
    "planejar" { Invoke-Planejador }
    "status"   { Show-Status }
    "uma-vez"  { Invoke-Passada | Out-Null }
    "loop" {
      Log "Loop iniciado (a cada $($script:Cfg.intervaloMinutos) min). Crie o arquivo PARAR na raiz para encerrar."
      while ($true) {
        if (-not (Invoke-Passada)) { break }
        $ate = (Get-Date).AddMinutes([double]$script:Cfg.intervaloMinutos)
        while ((Get-Date) -lt $ate) {
          if (Test-Parar) { break }
          Start-Sleep -Seconds 10
        }
        if (Test-Parar) { Log "Arquivo PARAR encontrado; encerrando." "AVISO"; break }
      }
    }
  }
}

# Permite carregar as funções com ". .\despachante.ps1" (testes) sem rodar nada.
if ($MyInvocation.InvocationName -ne ".") { Main }
