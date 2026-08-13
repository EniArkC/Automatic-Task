@echo off
rem Backup demo: writes a marker file into the run workspace.
if not exist "%1" mkdir "%1"
echo backup-ok > "%1\marker.txt"
echo backup complete for %1
