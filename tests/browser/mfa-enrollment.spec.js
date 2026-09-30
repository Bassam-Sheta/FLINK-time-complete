'use strict';
const {test,expect} = require('@playwright/test');
for (const portal of ['user','admin','superadmin']) {
  test(portal+' account can enroll MFA and apply rotated session', async ({page}) => {
    page.on('dialog', dialog => dialog.accept());
    await page.addInitScript(() => sessionStorage.setItem('flink_session_token','SESSION-EXISTING'));
    await page.goto('/'+portal);
    await page.getByRole('button',{name:'Account',exact:true}).click();
    await page.getByRole('button',{name:'Set up / Replace MFA',exact:true}).click();
    await expect(page.locator('#mfaCurrentPassword')).toHaveCount(0);
    await page.getByRole('button',{name:'Generate enrollment secret',exact:true}).click();
    await expect(page.locator('#mfaEnrollmentSecret')).toHaveText('SYNTHETICSECRET');
    await page.locator('#mfaConfirmationCode').fill('000000');
    await page.getByRole('button',{name:'Confirm MFA',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('Invalid verification code');
    await page.locator('#mfaConfirmationCode').fill('123456');
    await page.getByRole('button',{name:'Confirm MFA',exact:true}).click();
    await expect(page.locator('#mfaEnrollmentSecret')).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('flink_session_token'))).toBe('SESSION-MFA-ROTATED');
  });
}
