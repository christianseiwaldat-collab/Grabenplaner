param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\output\planning-assistant-live'),
    [string]$Voice = 'Microsoft Hedda Desktop'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$destination = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synthesizer.SelectVoice($Voice)
    $phrases = @{
        balances = 'Wie viele Urlaubstage habe ich noch?'
        schedule = 'Wie arbeite ich nächste Woche?'
        vacation = 'Ich möchte vom vierzehnten bis achtzehnten April Urlaub nehmen.'
        time_off = 'Beantrage bitte nächsten Freitag einen Zeitausgleichstag.'
    }
    foreach ($entry in $phrases.GetEnumerator()) {
        $file = Join-Path $destination ($entry.Key + '.wav')
        $synthesizer.SetOutputToWaveFile($file)
        $prompt = New-Object System.Speech.Synthesis.PromptBuilder
        $prompt.AppendBreak([TimeSpan]::FromSeconds(8))
        $prompt.AppendText($entry.Value)
        $prompt.AppendBreak([TimeSpan]::FromSeconds(20))
        $synthesizer.Speak($prompt)
        Write-Output $file
    }
} finally {
    $synthesizer.Dispose()
}
