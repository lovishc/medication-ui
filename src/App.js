import React, { useState, useEffect, useMemo, useCallback } from 'react';
import './App.css';

function App() {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedMedicine, setSelectedMedicine] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [matchedGenerics, setMatchedGenerics] = useState([]);
  const [loading, setLoading] = useState(false);
  const [drugFilter, setDrugFilter] = useState('all'); // 'all', 'branded', 'generic'
  
  // Data states
  const [medicationsData, setMedicationsData] = useState([]);
  const [searchIndex, setSearchIndex] = useState({ descriptions: [] });
  const [dataLoaded, setDataLoaded] = useState(false);

  // Load data on component mount
  useEffect(() => {
    const loadData = async () => {
      try {
        console.log('Loading data...');
        
        // Load data files
        const [medicationsResponse, indexResponse] = await Promise.all([
          fetch('./data/medications.json'),
          fetch('./data/search-index.json')
        ]);

        const medications = await medicationsResponse.json();
        const index = await indexResponse.json();

        setMedicationsData(medications);
        setSearchIndex(index);
        setDataLoaded(true);
        
        console.log('Data loaded successfully!');
        console.log(`Medications: ${medications.length}`);
        console.log(`Search index: ${index.descriptions.length} descriptions`);
        
      } catch (error) {
        console.error('Error loading data:', error);
        // Fallback to empty data
        setMedicationsData([]);
        setSearchIndex({ descriptions: [] });
        setDataLoaded(true);
      }
    };

    loadData();
  }, []);

  // Helper function to check if a value is null or empty
  const isNullOrEmpty = (value) => {
    return !value || value === 'NULL' || value === '' || value === null || value === undefined;
  };

  // Helper function to format display values (replace NULL with --)
  const formatDisplayValue = (value) => {
    if (isNullOrEmpty(value)) {
      return '--';
    }
    return value;
  };

  // Helper function to extract strength numbers and units from text
  const extractStrengthInfo = useCallback((description) => {
    if (!description) return { numbers: [], units: [] };
    
    // Match patterns like "10 MG", "2.5 ML", "100 MCG", etc.
    const strengthPattern = /(\d+(?:\.\d+)?)\s*(MG|MCG|ML|GM|G|L|UNIT|UNITS?|%)/gi;
    const matches = [...description.matchAll(strengthPattern)];
    
    const numbers = matches.map(match => parseFloat(match[1]));
    const units = matches.map(match => match[2].toUpperCase());
    
    return { numbers, units };
  }, []);

  // Filter suggestions based on search term and drug filter
  const filteredSuggestions = useMemo(() => {
    if (!searchTerm || searchTerm.length < 2 || !dataLoaded) return [];
    
    const term = searchTerm.toLowerCase();
    let suggestions = searchIndex.descriptions
      .filter(desc => desc.toLowerCase().includes(term));
    
    // Apply drug filter
    if (drugFilter === 'branded') {
      // Show only branded drugs (classification_for_rate_setting = 'B')
      suggestions = suggestions.filter(desc => {
        const medicine = medicationsData.find(
          med => med.ndc_description && 
          med.ndc_description.toLowerCase() === desc.toLowerCase()
        );
        return medicine && medicine.classification_for_rate_setting === 'B';
      });
    } else if (drugFilter === 'generic') {
      // Show only generic drugs (classification_for_rate_setting = 'G')
      suggestions = suggestions.filter(desc => {
        const medicine = medicationsData.find(
          med => med.ndc_description && 
          med.ndc_description.toLowerCase() === desc.toLowerCase()
        );
        return medicine && medicine.classification_for_rate_setting === 'G';
      });
    }
    // If drugFilter === 'all', show all drugs (no additional filtering)
    
    return suggestions.slice(0, 10); // Limit to 10 suggestions
  }, [searchTerm, searchIndex, medicationsData, dataLoaded, drugFilter]);

  useEffect(() => {
    setSuggestions(filteredSuggestions);
    setShowSuggestions(filteredSuggestions.length > 0 && searchTerm.length >= 2);
  }, [filteredSuggestions, searchTerm]);

  // Handle medicine selection
  const handleMedicineSelect = useCallback((description) => {
    if (!description) return;
    
    setLoading(true);
    setSearchTerm(description);
    setShowSuggestions(false);
    
    // Find all medications with this exact description
    const exactMatches = medicationsData.filter(med => med.ndc_description === description);
    
    if (exactMatches.length === 0) {
      setSelectedMedicine(null);
      setMatchedGenerics([]);
      setLoading(false);
      return;
    }

    // Get the first medicine for details
    const medicine = exactMatches.find(med => med.fda_product_id) || exactMatches[0];
    setSelectedMedicine({
      ...medicine,
      allMatches: exactMatches // Include all NDCs with this description
    });

    // Extract strength info from selected medicine
    const selectedStrength = extractStrengthInfo(description);

    // Find FDA nonproprietary name
    let fdaNonproprietaryName = null;
    for (const match of exactMatches) {
      if (!isNullOrEmpty(match.fda_nonproprietary_name)) {
        fdaNonproprietaryName = match.fda_nonproprietary_name;
        break;
      }
    }

    console.log('Selected medicine FDA name:', fdaNonproprietaryName);

    // If we found an FDA nonproprietary name, search for generics
    if (fdaNonproprietaryName) {
      const genericMatches = medicationsData.filter(med => {
        // Must have generic classification
        if (med.classification_for_rate_setting !== 'G') return false;
        
        // Must contain the FDA nonproprietary name (soft match)
        const hasNonproprietaryMatch = 
          !isNullOrEmpty(med.fda_nonproprietary_name) &&
          med.fda_nonproprietary_name.toLowerCase().includes(fdaNonproprietaryName.toLowerCase());
        
        const hasDescriptionMatch = 
          med.ndc_description.toLowerCase().includes(fdaNonproprietaryName.toLowerCase());
        
        if (!hasNonproprietaryMatch && !hasDescriptionMatch) return false;

        // Check strength matching
        const genericStrength = extractStrengthInfo(med.ndc_description);
        
        // Check if any strength numbers match
        const hasMatchingStrength = selectedStrength.numbers.some(selectedNum =>
          genericStrength.numbers.some(genericNum => Math.abs(selectedNum - genericNum) < 0.001)
        );
        
        // Check if any units match
        const hasMatchingUnit = selectedStrength.units.some(selectedUnit =>
          genericStrength.units.some(genericUnit => 
            selectedUnit.toLowerCase() === genericUnit.toLowerCase()
          )
        );

        // Must have either matching strength or be a close match
        return (hasMatchingStrength && hasMatchingUnit) || selectedStrength.numbers.length === 0;
      });

      // Remove duplicates based on NDC and labeler name combination
      const uniqueGenerics = [];
      const seen = new Set();

      genericMatches.forEach(med => {
        const key = `${med.ndc}-${med.labeler_name || 'unknown'}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueGenerics.push(med);
        }
      });

      console.log(`Found ${uniqueGenerics.length} matching generics for ${fdaNonproprietaryName}`);
      setMatchedGenerics(uniqueGenerics);
    } else {
      console.log('No FDA nonproprietary name found');
      setMatchedGenerics([]);
    }

    setLoading(false);
  }, [medicationsData, extractStrengthInfo]);

  const handleSearch = () => {
    if (!searchTerm.trim() || !dataLoaded) return;
    
    // Use the sophisticated handleMedicineSelect logic
    handleMedicineSelect(searchTerm);
  };



  const handleSuggestionClick = (suggestion) => {
    setSearchTerm(suggestion);
    setShowSuggestions(false);
    // Use the sophisticated handleMedicineSelect logic
    setTimeout(() => {
      handleMedicineSelect(suggestion);
    }, 100);
  };

  const formatPrice = (price) => {
    if (isNullOrEmpty(price)) return '--';
    return `$${parseFloat(price).toFixed(5)}`;
  };

  const formatStrength = (strength, unit) => {
    if (isNullOrEmpty(strength) && isNullOrEmpty(unit)) return '--';
    return `${formatDisplayValue(strength)} ${formatDisplayValue(unit)}`.trim();
  };

  // Show loading state while data is being loaded
  if (!dataLoaded) {
    return (
      <div className="App">
        <header className="app-header">
          <h1>🏥 Medicine Search - NADAC Database</h1>
          <p>Loading medication data...</p>
        </header>
        <main className="main-content">
          <div className="loading-state">
            <h2>⏳ Loading Data...</h2>
            <p>Please wait while we load the medication database.</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="App">
      <header className="app-header">
        <h1>🏥 Medicine Search - NADAC Database</h1>
        <p>Search for medications and find generic alternatives with pricing information</p>
        <p><small>Database loaded: {medicationsData.length} medications available</small></p>
      </header>

      <main className="main-content">
        {/* Search Section */}
        <div className="search-section">
          <h2>🔍 Search Medicine</h2>
          
          {/* Filter Controls */}
          <div className="search-filter-controls">
            <div className="three-way-switch">
              <button
                className={`switch-option ${drugFilter === 'branded' ? 'active' : ''}`}
                onClick={() => setDrugFilter('branded')}
              >
                Show Branded Drugs
              </button>
              <button
                className={`switch-option ${drugFilter === 'generic' ? 'active' : ''}`}
                onClick={() => setDrugFilter('generic')}
              >
                Show Generic Drugs
              </button>
              <button
                className={`switch-option ${drugFilter === 'all' ? 'active' : ''}`}
                onClick={() => setDrugFilter('all')}
              >
                Show All
              </button>
            </div>
          </div>
          
          <div className="search-container">
            <div className="search-input-container">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Type medicine name (e.g., ACETAMINOPHEN 500 MG TABLET)"
                className="search-input"
                onFocus={() => setShowSuggestions(filteredSuggestions.length > 0)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              />
              <button 
                onClick={handleSearch} 
                className="search-button"
                disabled={loading || !dataLoaded}
              >
                {loading ? '⏳' : '🔍'} Search
              </button>
            </div>
            
            {/* Suggestions Dropdown */}
            {showSuggestions && (
              <div className="suggestions-dropdown">
                {suggestions.map((suggestion, index) => (
                  <div 
                    key={index}
                    className="suggestion-item"
                    onClick={() => handleSuggestionClick(suggestion)}
                  >
                    {suggestion}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Selected Medicine Details */}
        {selectedMedicine ? (
          <div className="medicine-details">
            <h2>💊 Selected Medicine Details</h2>
            <div className="details-card">
              <div className="detail-section">
                <h3>Basic Information</h3>
                <div className="detail-grid">
                  <div className="detail-item">
                    <label>Drug Description:</label>
                    <span>{formatDisplayValue(selectedMedicine.ndc_description)}</span>
                  </div>
                  <div className="detail-item">
                    <label>NDC:</label>
                    <span>{formatDisplayValue(selectedMedicine.ndc)}</span>
                  </div>
                  <div className="detail-item">
                    <label>NADAC Per Unit:</label>
                    <span className="price">{formatPrice(selectedMedicine.nadac_per_unit)}</span>
                  </div>
                  <div className="detail-item">
                    <label>Pricing Unit:</label>
                    <span>{formatDisplayValue(selectedMedicine.pricing_unit)}</span>
                  </div>
                  <div className="detail-item">
                    <label>Classification:</label>
                    <span className={`classification ${selectedMedicine.classification_for_rate_setting}`}>
                      {selectedMedicine.classification_for_rate_setting === 'G' ? 'Generic' : 'Brand'}
                    </span>
                  </div>
                  <div className="detail-item">
                    <label>OTC:</label>
                    <span>{formatDisplayValue(selectedMedicine.otc)}</span>
                  </div>
                </div>
              </div>

              {selectedMedicine.fda_product_id ? (
                <div className="detail-section">
                  <h3>FDA Information</h3>
                  <div className="detail-grid">
                    <div className="detail-item">
                      <label>FDA Nonproprietary Name:</label>
                      <span>{formatDisplayValue(selectedMedicine.fda_nonproprietary_name)}</span>
                    </div>
                    <div className="detail-item">
                      <label>Proprietary Name:</label>
                      <span>{formatDisplayValue(selectedMedicine.fda_proprietary_name)}</span>
                    </div>
                    <div className="detail-item">
                      <label>Dosage Form:</label>
                      <span>{formatDisplayValue(selectedMedicine.fda_dosage_form_name)}</span>
                    </div>
                    <div className="detail-item">
                      <label>Route:</label>
                      <span>{formatDisplayValue(selectedMedicine.fda_route_name)}</span>
                    </div>
                    <div className="detail-item">
                      <label>Labeler:</label>
                      <span>{formatDisplayValue(selectedMedicine.fda_labeler_name)}</span>
                    </div>
                    <div className="detail-item">
                      <label>Active Strength:</label>
                      <span>{formatStrength(selectedMedicine.fda_active_numerator_strength, selectedMedicine.fda_active_ingred_unit)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="no-fda-info">
                  <h3>❌ No FDA Information Available</h3>
                  <p>No detailed FDA information available for this medication.</p>
                </div>
              )}
            </div>
          </div>
        ) : searchTerm && !loading ? (
          <div className="no-results">
            <h2>❌ No Results Found</h2>
            <p>No medication found matching "{searchTerm}". Please check the spelling or try a different search term.</p>
          </div>
        ) : null}

        {/* Matched Generic Drugs Section */}
        {matchedGenerics.length > 0 && selectedMedicine && (
          <div className="generic-drugs-section">
            <h2>🧬 Matching Generic Options</h2>
            <p>Found {matchedGenerics.length} generic options for <strong>{selectedMedicine.fda_nonproprietary_name}</strong></p>
            
            <div className="generic-drugs-grid">
              {matchedGenerics.slice(0, 50).map((drug, index) => (
                <div key={index} className="generic-drug-card">
                  <div className="drug-name">{drug.ndc_description}</div>
                  <div className="drug-details">
                    <div className="price-info">
                      <span className="price">{formatPrice(drug.nadac_per_unit)}</span>
                      <span className="unit">per {drug.pricing_unit}</span>
                    </div>
                    <div className="classification">
                      <span className={`classification ${drug.classification_for_rate_setting}`}>
                        {drug.classification_for_rate_setting === 'G' ? 'Generic' : 'Brand'}
                      </span>
                    </div>
                    {!isNullOrEmpty(drug.fda_labeler_name) && (
                      <div className="labeler-name">
                        <strong>Labeler:</strong> {formatDisplayValue(drug.fda_labeler_name)}
                      </div>
                    )}
                    {!isNullOrEmpty(drug.fda_active_numerator_strength) && (
                      <div className="strength-info">
                        <strong>Strength:</strong> {formatStrength(drug.fda_active_numerator_strength, drug.fda_active_ingred_unit)}
                      </div>
                    )}
                    <div className="ndc">
                      <strong>NDC:</strong> {formatDisplayValue(drug.ndc)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            
            {matchedGenerics.length > 50 && (
              <p className="showing-limited">Showing first 50 of {matchedGenerics.length} results</p>
            )}
          </div>
        )}
      </main>

      <footer className="app-footer">
        <p>Medicine Search App - NADAC Database | Data as of latest update</p>
      </footer>
    </div>
  );
}

export default App; 