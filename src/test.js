// test.js — Simple Supabase connection test (read config, test RLS, test Edge Function)
import { supabase } from './supabaseClient.js';

const outputEl = document.getElementById('output');
const toastEl = document.getElementById('toast');
const testBtn = document.getElementById('test-btn');

function log(msg) {
  outputEl.textContent += msg + '\n';
}

function showToast(msg, type = 'error') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
}

testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  outputEl.textContent = '';
  log('=== Supabase Connection Test ===\n');

  // Test 1: Read config table (anon has SELECT on config)
  log('1. Reading config table...');
  try {
    const { data: config, error } = await supabase
      .from('config')
      .select('*')
      .single();

    if (error) throw error;

    log('   ✅ Config loaded successfully!');
    log(`   Xanax price: $${Number(config.xanax_price).toLocaleString()}`);
    log(`   EDVD price: $${Number(config.edvd_price).toLocaleString()}`);
    log(`   Ecstasy price: $${Number(config.ecstasy_price).toLocaleString()}`);
    log(`   Rehab bonus: $${Number(config.rehab_bonus).toLocaleString()}`);
    log(`   Target margin: ${(config.target_margin * 100)}%`);
    log(`   Reserve: $${Number(config.current_reserve).toLocaleString()}`);
    log('');
  } catch (err) {
    log(`   ❌ Config read failed: ${err.message}`);
    log('');
  }

  // Test 2: Verify RLS blocks direct anon inserts to transactions
  log('2. Testing RLS on transactions (should be blocked)...');
  try {
    const { error } = await supabase
      .from('transactions')
      .insert({
        torn_id: '0',
        torn_name: 'TestPlayer',
        package_cost: 0,
        suggested_price: 0,
        xanax_payout: 0,
        ecstasy_payout: 0,
      });

    if (error) {
      log('   ✅ RLS correctly blocked direct insert (transactions go through Edge Function)');
    } else {
      log('   ⚠️ Direct insert was allowed — check RLS policies');
    }
    log('');
  } catch (err) {
    log(`   ✅ RLS correctly blocked direct insert`);
    log('');
  }

  // Test 3: Call gateway Edge Function with torn-proxy action (invalid key — should return Torn API error)
  log('3. Testing gateway (torn-proxy action)...');
  try {
    const { data, error } = await supabase.functions.invoke('gateway', {
      body: { action: 'torn-proxy', key: 'test', section: 'user', selections: 'basic' },
    });

    if (error) throw error;

    // Torn API will return an error for invalid key — that's expected
    if (data.error) {
      log(`   ✅ Gateway responded! Torn API said: "${data.error.error}" (expected for test key)`);
    } else {
      log('   ✅ Gateway responded with data!');
    }
    log('');
  } catch (err) {
    log(`   ❌ Edge Function call failed: ${err.message}`);
    log('');
  }

  log('=== Test Complete ===');
  showToast('Tests finished — check results above.', 'success');
  testBtn.disabled = false;
});
