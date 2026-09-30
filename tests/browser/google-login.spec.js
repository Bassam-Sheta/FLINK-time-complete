'use strict';
const {test,expect} = require('@playwright/test');
for (const portal of ['user','admin','superadmin']) {
  test(portal+' signs in through Google identity and an app MFA challenge', async ({page}) => {
    await page.goto('/'+portal);
    await expect(page.locator('#loginView')).toBeVisible();
    await expect(page.locator('#loginView input[type=password]')).toHaveCount(0);
    await page.getByRole('button',{name:'Continue with Google',exact:true}).click();
    await expect(page.locator('#mfaLoginForm')).toBeVisible();
    await page.locator('#mfaCode').fill('123456');
    await page.getByRole('button',{name:'Verify & Sign In',exact:true}).click();
    await expect(page.getByRole('button',{name:'Account',exact:true})).toBeVisible();
    const calls = await page.evaluate(()=>window.__mockState.calls);
    const login = calls.find(call=>call.action === 'auth.login');
    expect(login.body.payload.password).toBeUndefined();
    expect(login.body.payload.username).toBeUndefined();
  });
}
