import assert from 'node:assert/strict';
import test from 'node:test';
import {CATALOG_ENVIRONMENT_CREDENTIALS,isCatalogCredentialReference,isEnvironmentCredentialReference,
  readCatalogEnvironmentCredential} from '../scripts/catalog/credential-reference.ts';
import {resolveCatalogCredential,resolveCloudflareCredential,validateRunnerCheckConfig} from '../scripts/catalog/check-cloudflare-runner.ts';

const fixture='SYNTHETIC_NOT_A_CREDENTIAL';
const reference=role=>({type:'environment',name:CATALOG_ENVIRONMENT_CREDENTIALS[role]});
const keychain={service:'goose.gifts.test-only',account:'fixture'};

test('hosted references are exact, role-bound names, never arbitrary ambient aliases',()=>{
  for(const role of Object.keys(CATALOG_ENVIRONMENT_CREDENTIALS)){
    assert.equal(isCatalogCredentialReference(reference(role),role),true);
    assert.equal(isEnvironmentCredentialReference(reference(role)),true);
    for(const other of Object.keys(CATALOG_ENVIRONMENT_CREDENTIALS).filter(value=>value!==role))
      assert.equal(isCatalogCredentialReference(reference(role),other),false);
  }
  assert.equal(isCatalogCredentialReference(keychain),true);
  for(const value of [null,[],{},'OPENAI_API_KEY',{type:'environment',name:'OPENAI_API_KEY'},
    {type:'environment',name:'STUPID_GIFTS_OTHER'},{...reference('openai'),fallback:'OPENAI_API_KEY'},
    {type:'environment',name:'STUPID_GIFTS_OPENAI_API_KEY\n'}]){
    assert.equal(isCatalogCredentialReference(value),false);
    assert.throws(()=>readCatalogEnvironmentCredential(value,{}),/catalog_credential_reference/);
  }
});

test('missing or invalid hosted values do not leak or fall back to another credential',async()=>{
  const ref=reference('openai');
  assert.equal(readCatalogEnvironmentCredential(ref,{[ref.name]:fixture}),fixture);
  for(const value of [undefined,'','PRIVATE\nVALUE',' PRIVATE','x'.repeat(4097)]){
    const environment={OPENAI_API_KEY:fixture,...(value===undefined?{}:{[ref.name]:value})};
    assert.throws(()=>readCatalogEnvironmentCredential(ref,environment),/^Error: catalog_environment_credential_unavailable$/);
    await assert.rejects(resolveCatalogCredential(ref,async()=>assert.fail('No Keychain fallback'),
      selected=>readCatalogEnvironmentCredential(selected,environment)),/^Error: catalog_environment_credential_unavailable$/);
  }
});

test('explicit hosted and legacy references use only their chosen resolver',async()=>{
  const noKeychain=async()=>assert.fail('No Keychain lookup'),noOAuth=async()=>assert.fail('No OAuth lookup');
  assert.equal(await resolveCatalogCredential(reference('amazonId'),noKeychain,ref=>{
    assert.deepEqual(ref,reference('amazonId'));return fixture;
  }),fixture);
  assert.equal(await resolveCloudflareCredential(reference('cloudflare'),noKeychain,noOAuth,ref=>{
    assert.deepEqual(ref,reference('cloudflare'));return fixture;
  }),fixture);
  assert.equal(await resolveCatalogCredential(keychain,async ref=>{assert.deepEqual(ref,keychain);return fixture;},
    ()=>assert.fail('No environment lookup')),fixture);
  await assert.rejects(resolveCloudflareCredential(reference('openai'),noKeychain,noOAuth,()=>assert.fail('Wrong-role lookup')),
    /^Error: runner_check_cloudflare_reference$/);
});

test('read-only runner accepts only the explicit hosted Cloudflare role',()=>{
  const config={schemaVersion:1,environment:'production',accountId:'a'.repeat(32),
    database:{id:'00000000-0000-4000-8000-000000000001',name:'fixture-db'},
    vectorIndex:{name:'fixture-index',dimensions:1536,metric:'cosine'},
    catalog:{associateTag:'fixture-20',marketplace:'www.amazon.com'},cloudflareReadToken:reference('cloudflare')};
  assert.deepEqual(validateRunnerCheckConfig(config),config);
  assert.throws(()=>validateRunnerCheckConfig({...config,cloudflareReadToken:reference('openai')}),/runner_check_config_invalid/);
});
