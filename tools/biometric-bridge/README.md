# Biometric bridge

Runs on the PC where eTimeTrackLite is installed. Every 10 minutes it reads new punches from the local database and sends them to the ERP over https. The ERP never connects into your network, and the SQL password never leaves this PC.

## One-time setup (on the biometric PC)

1. Install Node.js LTS from nodejs.org (64-bit) if `node -v` fails in a command prompt.
2. Copy this folder to `C:\startuptn-bridge`.
3. In a command prompt: `cd C:\startuptn-bridge` then `npm install`.
4. Copy `.env.example` to `.env` and fill in `SQL_PASSWORD` and `PUSH_TOKEN`
   (the same value you set as `BIOMETRIC_PUSH_TOKEN` in the Render API service; at least 16 random characters).
5. Test the connection: `node bridge.js --inspect` (reads only, sends nothing). It lists the punch tables and row counts.
6. First real run: `node bridge.js`. Check HR > Attendance setup > Biometric machine for the new import.
7. Schedule it (run once, in an administrator command prompt):

```
schtasks /Create /TN "StartupTN Biometric Bridge" /SC MINUTE /MO 10 /TR "cmd /c cd /d C:\startuptn-bridge && node bridge.js" /RU SYSTEM /F
```

Progress is written to `bridge.log` in the same folder.

## If the connection fails

- Open "SQL Server Configuration Manager": enable **TCP/IP** for SQLEXPRESS and start **SQL Server Browser**, then restart the SQL Server service.
- Or find the port in TCP/IP properties and set `SQL_PORT=` in `.env`.
- Check the SQL login `essl` and its password.

## Notes

- Safe to run repeatedly: the ERP ignores punches it already has. Each run re-reads the last hour in case the machine uploaded late.
- The first run reads the last 45 days (`FIRST_RUN_DAYS`). Delete `state.json` to read that far back again.
- Employees match by machine code = the employee's biometric code in the ERP. Unknown codes are listed in the Biometric setup page.
- The PC must be on, with the eTimeTrackLite service running, for attendance to update.
