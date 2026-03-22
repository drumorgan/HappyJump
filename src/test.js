// test.js — Simple Supabase connection test (read config, write+read transaction)
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

  // Test 1: Read config table
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

  // Test 2: Insert a test transaction
  log('2. Inserting test transaction...');
  try {
    const { data: txn, error } = await supabase
      .from('transactions')
      .insert({
        torn_id: '0',
        torn_name: 'TestPlayer',
        torn_faction: 'TestFaction',
        torn_level: 1,
        status: 'requested',
        package_cost: 23470000,
        suggested_price: 27612000,
        xanax_payout: 4400000,
        ecstasy_payout: 24470000,
      })
      .select('id, torn_name, status, suggested_price')
      .single();

    if (error) throw error;

    log(`   ✅ Transaction inserted!`);
    log(`   ID: ${txn.id}`);
    log(`   Player: ${txn.torn_name}`);
    log(`   Status: ${txn.status}`);
    log(`   Price: $${Number(txn.suggested_price).toLocaleString()}`);
    log('');

    // Test 3: Read it back
    log('3. Reading transaction back...');
    const { data: readBack, error: readErr } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', txn.id)
      .single();

    if (readErr) throw readErr;

    log(`   ✅ Transaction read back successfully!`);
    log(`   Created at: ${readBack.created_at}`);
    log('');

    // Test 4: Delete the test row (cleanup)
    log('4. Cleaning up test transaction...');
    const { error: delErr } = await supabase
      .from('transactions')
      .delete()
      .eq('id', txn.id);

    if (delErr) throw delErr;
    log('   ✅ Test transaction deleted.');
    log('');

  } catch (err) {
    log(`   ❌ Transaction test failed: ${err.message}`);
    log('');
  }

  // Test 5: Call an Edge Function (torn-proxy with no key — should return error gracefully)
  log('5. Testing torn-proxy Edge Function...');
  try {
    const { data, error } = await supabase.functions.invoke('torn-proxy', {
      body: { key: 'test', section: 'user', selections: 'basic' },
    });

    if (error) throw error;

    // Torn API will return an error for invalid key — that's expected
    if (data.error) {
      log(`   ✅ Edge Function responded! Torn API said: "${data.error.error}" (expected for test key)`);
    } else {
      log('   ✅ Edge Function responded with data!');
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
