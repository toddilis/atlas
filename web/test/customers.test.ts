import assert from 'node:assert/strict';
import test from 'node:test';
import {
  companyOf, customerName, customerOutcomeFor, decidedText, decisionToken, groupHeld, isCustomerOutcome, suggestRetailer,
  type HeldShipment, type RetailerOption,
} from '../lib/customers';

test('the decision token matches the database: retailer id, not_invoiced or undecided (0054)', () => {
  assert.equal(decisionToken({ account_id: 'acct-1', do_not_invoice: false }), 'acct-1');
  assert.equal(decisionToken({ account_id: null, do_not_invoice: true }), 'not_invoiced');
  assert.equal(decisionToken({ account_id: null, do_not_invoice: false }), 'undecided');
});

test('customers read as a name, else an email, else their Shopify id; company comes from the default address', () => {
  assert.equal(customerName({ first_name: ' Komal ', last_name: null, email: 'k@x.test', shopify_customer_id: '1' }), 'Komal');
  assert.equal(customerName({ first_name: 'Erin', last_name: 'Buyer', email: null, shopify_customer_id: '1' }), 'Erin Buyer');
  assert.equal(customerName({ first_name: ' ', last_name: null, email: 'blackwatch@school.test', shopify_customer_id: '1' }), 'blackwatch@school.test');
  assert.equal(customerName({ first_name: null, last_name: null, email: null, shopify_customer_id: '42' }), 'Shopify customer 42');
  assert.equal(companyOf({ company: ' Stirling Sports Levin ' }), 'Stirling Sports Levin');
  assert.equal(companyOf({ company: '' }), null);
  assert.equal(companyOf(null), null);
  assert.equal(companyOf('not an address'), null);
});

test('a retailer is suggested only on unambiguous evidence', () => {
  const retailers: RetailerOption[] = [
    { id: 'levin', name: 'Stirling Sports Levin', billing_email: 'Accounts@Levin.test' },
    { id: 'blenheim', name: 'Blenheim Stirling Sports', billing_email: null },
    { id: 'pickle', name: 'Love Pickle', billing_email: 'shop@lovepickle.test' },
  ];
  // The retailer's billing email, in any case.
  assert.deepEqual(suggestRetailer({ email: 'accounts@levin.test', company: null }, retailers, []),
    { accountId: 'levin', why: 'the retailer’s billing email' });
  // The retailer's name as the customer's company.
  assert.deepEqual(suggestRetailer({ email: 'komal@x.test', company: 'blenheim stirling sports' }, retailers, []),
    { accountId: 'blenheim', why: 'the retailer’s name as its company' });
  // Another record of the same buyer: a linked customer with the same company.
  assert.deepEqual(suggestRetailer({ email: 'komal2@x.test', company: 'Levin/Masterton' }, retailers,
    [{ company: 'levin/masterton', account_id: 'levin' }]),
  { accountId: 'levin', why: 'another customer with the same company' });
  // Two linked customers with that company point at different retailers: no suggestion.
  assert.equal(suggestRetailer({ email: 'k3@x.test', company: 'Stirling Sports' }, retailers,
    [{ company: 'Stirling Sports', account_id: 'levin' }, { company: 'Stirling Sports', account_id: 'blenheim' }]), null);
  // A sibling linked to a retailer no longer offered (closed) is not suggested.
  assert.equal(suggestRetailer({ email: 'k4@x.test', company: 'Old Shop' }, retailers, [{ company: 'Old Shop', account_id: 'closed-one' }]), null);
  // Nothing to go on.
  assert.equal(suggestRetailer({ email: null, company: null }, retailers, []), null);
});

test('held shipments are grouped per customer, oldest first, shipments without a customer last', () => {
  const s = (id: string, at: string, customer: string | null): HeldShipment =>
    ({ id, occurred_at: at, order: { shopify_order_name: `#${id}`, shopify_customer_id: customer, financial_status: 'pending', total_cents: 100, currency: 'NZD' } });
  const groups = groupHeld([s('3', '2026-11-03T00:00:00Z', 'b'), s('1', '2026-11-01T00:00:00Z', null), s('2', '2026-11-02T00:00:00Z', 'b'),
    s('4', '2026-11-01T12:00:00Z', 'a')]);
  assert.deepEqual(groups.map(g => [g.shopifyCustomerId, g.shipments.map(x => x.id)]), [['a', ['4']], ['b', ['2', '3']], [null, ['1']]]);
});

test('database refusals map to fixed outcomes, and a decision says what it released', () => {
  assert.equal(customerOutcomeFor('business actions paused'), 'paused');
  assert.equal(customerOutcomeFor('tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(customerOutcomeFor('deciding a customer cannot itself require an approval; its grant must not require approval'), 'not_allowed');
  assert.equal(customerOutcomeFor('a reason is required to stop invoicing a customer'), 'reason_required');
  assert.equal(customerOutcomeFor('reason too long'), 'reason_required');
  assert.equal(customerOutcomeFor('retailer is closed'), 'retailer_closed');
  assert.equal(customerOutcomeFor('customer decision changed since it was loaded'), 'stale');
  assert.equal(customerOutcomeFor('shopify customer not found'), 'not_found');
  assert.equal(customerOutcomeFor('retailer not found'), 'not_found');
  assert.equal(customerOutcomeFor('operator identity required'), 'failed');
  assert.equal(customerOutcomeFor('deadlock detected'), 'failed');
  assert.ok(isCustomerOutcome('linked') && !isCustomerOutcome('toString'));

  assert.equal(decidedText('retailer', 1, 0),
    'Customer linked. Its unpaid orders shipped from the warehouse are invoiced to that retailer. 1 waiting shipment goes to invoicing.');
  assert.equal(decidedText('retailer', 2, 1), 'Customer linked. Its unpaid orders shipped from the warehouse are invoiced to that retailer. '
    + '2 waiting shipments go to invoicing; 1 waiting shipment is not invoiced.');
  assert.equal(decidedText('not_invoiced', 0, 3), 'Customer marked not invoiced. Atlas will not invoice its orders. 3 waiting shipments are not invoiced.');
  assert.equal(decidedText('undecided', 0, 0), 'Decision removed. Its unpaid draft orders will wait here again when they ship.');
});
