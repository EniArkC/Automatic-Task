@echo off
rem Package-local script: runs with the installed package directory as base.
echo fetching weather data for %1
echo {"city":"%1","temp":28,"humidity":60} > report.json
echo fetch complete
