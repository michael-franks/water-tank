# Email Alert Setup

Email alerts are configured to send to **michael@franks.co.nz** when:
- Water level drops below 50%, 25%, or 10%
- Water level changes by 10% or more within 6 hours

## Setup Instructions

### Option 1: Gmail (Easiest)

1. **Enable 2-Factor Authentication** on your Gmail account (if not already enabled)

2. **Generate an App Password**:
   - Go to https://myaccount.google.com/apppasswords
   - Select "Mail" and "Other (Custom name)"
   - Enter "Water Tank Monitor" as the name
   - Copy the 16-character password

3. **Update `.env` file** on the server:
   ```bash
   # SSH into the server
   ssh root@ssh-proxmox.franks.nz
   
   # Edit the .env file
   pct exec 104 -- nano /root/water-tank-monitor/server/.env
   ```

4. **Add these lines** (replace with your Gmail address and app password):
   ```
   ALERT_EMAIL_TO=michael@franks.co.nz
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USERNAME=your-email@gmail.com
   SMTP_PASSWORD=your-16-char-app-password
   SMTP_FROM=your-email@gmail.com
   ```

5. **Restart the service**:
   ```bash
   pct exec 104 -- systemctl restart water-tank.service
   ```

### Option 2: Custom SMTP Server

If you have your own email server for `franks.co.nz`, use those SMTP settings:

```
ALERT_EMAIL_TO=michael@franks.co.nz
SMTP_HOST=mail.franks.co.nz  # or your SMTP server
SMTP_PORT=587  # or 465 for SSL
SMTP_USERNAME=your-username
SMTP_PASSWORD=your-password
SMTP_FROM=michael@franks.co.nz  # or your sending address
```

### Testing

To test email alerts, you can temporarily lower the threshold in the code or wait for an actual alert condition.

## Alert Types

1. **Threshold Alerts**: Triggered when water level drops below:
   - 50% (first warning)
   - 25% (moderate warning)
   - 10% (critical warning)
   
   Alerts re-arm when level rises above threshold + 2% (hysteresis).

2. **Rapid Change Alert**: Triggered when water level changes by 10% or more within 6 hours (indicates potential leak or rapid usage).
