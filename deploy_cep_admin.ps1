#!/usr/bin/env pwss
<#
.SYNOPSIS
    Deploy EditFlow AI CEP panel with admin privileges for unsigned extension support.
    This script self-elevates to Administrator and runs the junction installer.
#>

# Self-elevate to admin
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process PowerShell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$ScriptDir\install_cep_junction.ps1"
